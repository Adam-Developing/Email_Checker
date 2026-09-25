/* global document, chrome */

if (window.top === window.self) {

    // Persistent local cache module for email analyses
    let cacheModule = null;
    async function getCache() {
        if (!cacheModule) {
            cacheModule = await import(chrome.runtime.getURL('core/cache-manager.js'));
        }
        return cacheModule;
    }
    // Pre-warm cache module immediately
    getCache().catch((err) => console.warn("EmailChecker: Pre-warming cache module failed:", err));

    let currentMessageId = null;
    let currentUserEmail = null;
    let currentSessionId = null;
    let currentAbortController = null;
    let currentFromElement = null;

    // Badge looks for states without a verdict. Verdict looks arrive with the analysis report.
    const BADGES = {
        checking: { label: 'Checking…', sub: 'a few seconds', bg: '#f1f3f4', border: '#dfe3e8', ink: '#5f6368', dot: '#9aa4af', glyph: '⋯' },
        manual: { label: 'Check this email', sub: 'not checked yet', bg: '#f7f9fc', border: '#dfe3e8', ink: '#002B4D', dot: '#002B4D', glyph: '›' },
        auth: { label: 'Permission needed', sub: 'click to allow access', bg: '#f7f9fc', border: '#dfe3e8', ink: '#002B4D', dot: '#002B4D', glyph: '!' },
        error: { label: "Couldn't check", sub: 'click for details', bg: '#f1f3f4', border: '#dfe3e8', ink: '#5f6368', dot: '#9aa4af', glyph: '!' },
        off: { label: 'Not checked', sub: 'turned off for this account', bg: '#f1f3f4', border: '#dfe3e8', ink: '#5f6368', dot: '#9aa4af', glyph: '–' },
        noChecks: { label: 'No checks run', sub: 'every check is turned off', bg: '#f1f3f4', border: '#dfe3e8', ink: '#5f6368', dot: '#9aa4af', glyph: '–' },
    };

    function getAnalysisOverlay() {
        return document.querySelector('.ec-analysis-overlay');
    }

    let modalInjectionPromise = null;
    function ensureModalInjected() {
        const existing = getAnalysisOverlay();
        if (existing) return Promise.resolve(existing);
        if (!modalInjectionPromise) {
            modalInjectionPromise = (async () => {
                const current = getAnalysisOverlay();
                if (current) return current;

                const overlay = document.createElement('div');
                overlay.className = 'analysis-modal-overlay ec-analysis-overlay';
                overlay.style.display = 'none';
                overlay.onclick = (e) => { if (e.target === overlay) closePanel(); };

                const content = document.createElement('div');
                content.className = 'analysis-modal-content';

                const uiUrl = chrome.runtime.getURL('analysis-ui.html');
                try {
                    const response = await fetch(uiUrl);
                    content.innerHTML = await response.text();
                } catch (error) {
                    content.innerHTML = `
                        <div class="ec-pane-header">
                            <img class="ec-pane-icon" data-ec-icon alt="" />
                            <span class="ec-pane-title">Email Checker</span>
                            <span id="item-subject" class="ec-pane-status">Not checked yet</span>
                            <button type="button" class="ec-pane-rerun" data-ec-action="rerun" title="Rerun analysis on this email">
                                <svg class="ec-rerun-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
                                    <path d="M21 3v5h-5"/>
                                </svg>
                                <span>Rerun</span>
                            </button>
                            <button type="button" class="ec-pane-close" data-ec-action="close" aria-label="Close">&times;</button>
                        </div>
                        <div id="results-container" style="display: none;"></div>
                    `;
                }

                const icon = content.querySelector('[data-ec-icon]');
                if (icon) icon.src = chrome.runtime.getURL('assets/Icon.png');
                const closeButton = content.querySelector('[data-ec-action="close"]');
                if (closeButton) closeButton.onclick = closePanel;
                const rerunButton = content.querySelector('[data-ec-action="rerun"]');
                if (rerunButton) rerunButton.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleRerunRequest();
                };

                overlay.appendChild(content);
                document.body.appendChild(overlay);

                const link = document.createElement('link');
                link.href = chrome.runtime.getURL('core/shared-styles.css');
                link.type = 'text/css';
                link.rel = 'stylesheet';
                content.prepend(link);

                return overlay;
            })();
        }
        return modalInjectionPromise;
    }

    async function openPanel() {
        const overlay = getAnalysisOverlay() || await ensureModalInjected();
        if (overlay) {
            overlay.style.display = 'flex';
            const container = document.getElementById('results-container');
            if (container && (!container.innerHTML.trim() || container.style.display === 'none')) {
                const badge = document.querySelector('.ec-badge-label');
                const isChecking = badge && badge.textContent.includes('Checking');
                if (isChecking && currentMessageId) {
                    setStatus("Checking email…");
                    try {
                        const { initializeUI } = await import(chrome.runtime.getURL('core/analysis-core.js'));
                        chrome.storage.sync.get({ checks: {} }, (items) => {
                            initializeUI(container.id, currentSessionId || crypto.randomUUID(), items.checks);
                        });
                    } catch (e) {
                        console.error("EmailChecker: Error initializing live panel:", e);
                    }
                } else if (currentMessageId) {
                    const cache = await getCache();
                    const cached = cache.getCachedAnalysisSync(currentMessageId) || await cache.getCachedAnalysis(currentMessageId);
                    if (cached) {
                        await restoreCachedUI(cached);
                    } else {
                        const { renderNoticePanel } = await import(chrome.runtime.getURL('core/verdict-panel.js'));
                        container.innerHTML = renderNoticePanel({
                            title: "Email not checked yet",
                            sub: "Click 'Check this email' on the badge or 'Rerun' above to analyze.",
                        });
                        container.style.display = 'block';
                    }
                }
            }
        }
    }

    function closePanel() {
        const overlay = getAnalysisOverlay();
        if (overlay) overlay.style.display = 'none';
    }

    function setStatus(text) {
        const statusElement = document.getElementById('item-subject');
        if (statusElement) statusElement.innerText = text;
    }

    async function showNotice(notice) {
        await ensureModalInjected();
        const container = document.getElementById('results-container');
        if (!container) return;
        const { renderNoticePanel } = await import(chrome.runtime.getURL('core/verdict-panel.js'));
        container.innerHTML = renderNoticePanel(notice);
        container.style.display = 'block';
    }

    function injectBadge(fromElement) {
        document.querySelectorAll('.ec-badge').forEach(el => el.remove());
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'ec-badge';
        badge.innerHTML = '<span class="ec-badge-dot"></span><span class="ec-badge-text"><span class="ec-badge-label"></span><span class="ec-badge-sub"></span></span>';
        // Sits after the sender's name and address, outside the name's hover card.
        (fromElement.parentElement || fromElement).appendChild(badge);
    }

    function setBadge(look, onClick) {
        const badge = document.querySelector('.ec-badge');
        if (!badge) return;
        badge.style.background = look.bg;
        badge.style.borderColor = look.border;
        badge.style.color = look.ink;
        const dot = badge.querySelector('.ec-badge-dot');
        dot.style.background = look.dot;
        dot.textContent = look.glyph;
        badge.querySelector('.ec-badge-label').textContent = look.label;
        badge.querySelector('.ec-badge-sub').textContent = look.sub;
        badge.title = `${look.label} — ${look.sub}`;
        badge.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            onClick();
        };
    }

    function showSummaryBadge(summary) {
        setBadge(summary && summary.badge ? summary.badge : BADGES.noChecks, openPanel);
    }

    function findMessageParts(fromElement) {
        const message = fromElement && fromElement.closest('.adn');
        const body = message && (message.querySelector('.ii.gt') || message.querySelector('.a3s'));
        if (!body || !body.parentElement) return null;
        return { body, blurTargets: [body, message.querySelector('.hq.gt')].filter(Boolean) };
    }

    function clearInterstitial() {
        document.querySelectorAll('.ec-interstitial').forEach(el => el.remove());
        document.querySelectorAll('.ec-blurred').forEach(el => el.classList.remove('ec-blurred'));
    }

    function buildInterstitial(warning) {
        const box = document.createElement('div');
        box.className = 'ec-interstitial';
        box.innerHTML = `
            <span class="ec-interstitial-icon">!</span>
            <div class="ec-interstitial-title"></div>
            <div class="ec-interstitial-body"></div>
            <div class="ec-interstitial-actions">
                <button type="button" class="ec-btn-danger" data-ec-action="see-why">See why</button>
                <button type="button" class="ec-btn-quiet" data-ec-action="show-anyway">Show the email anyway</button>
            </div>`;
        box.querySelector('.ec-interstitial-title').textContent = warning.title;
        box.querySelector('.ec-interstitial-body').textContent = warning.body;
        box.querySelector('[data-ec-action="see-why"]').onclick = (e) => {
            e.stopPropagation();
            openPanel();
        };
        box.querySelector('[data-ec-action="show-anyway"]').onclick = async (e) => {
            e.stopPropagation();
            const cache = await getCache();
            const entry = await cache.getCachedAnalysis(currentMessageId);
            if (entry) {
                entry.dismissed = true;
                await cache.saveCachedAnalysis(currentMessageId, entry);
            }
            closePanel();
            clearInterstitial();
        };
        return box;
    }

    // Keeps the scam warning above a high-risk email, with its body blurred, until dismissed.
    // Runs on DOM changes too, because Gmail re-renders message bodies.
    async function ensureInterstitial() {
        if (!currentMessageId) {
            if (document.querySelector('.ec-interstitial, .ec-blurred')) clearInterstitial();
            return;
        }
        const cache = await getCache();
        const entry = cache.getCachedAnalysisSync(currentMessageId) || await cache.getCachedAnalysis(currentMessageId);
        const warning = entry && !entry.dismissed && entry.summary ? entry.summary.interstitial : null;
        const parts = warning ? findMessageParts(currentFromElement) : null;
        if (!parts) {
            if (document.querySelector('.ec-interstitial, .ec-blurred')) clearInterstitial();
            return;
        }
        let box = document.querySelector('.ec-interstitial');
        if (!box || box.nextElementSibling !== parts.body) {
            if (box) box.remove();
            box = buildInterstitial(warning);
            parts.body.parentElement.insertBefore(box, parts.body);
        }
        parts.blurTargets.forEach(el => {
            if (!el.classList.contains('ec-blurred')) el.classList.add('ec-blur-target', 'ec-blurred');
        });
    }

    async function restoreCachedUI(cached) {
        if (!cached) return;
        await ensureModalInjected();
        const resultsContainer = document.getElementById("results-container");
        if (resultsContainer) {
            const { renderReportPanel, bindPanel } = await import(chrome.runtime.getURL('core/verdict-panel.js'));
            let html = "";
            if (cached.results) {
                const { buildReport } = await import(chrome.runtime.getURL('core/report-model.js'));
                html = renderReportPanel(buildReport(cached.results));
            } else if (cached.report) {
                html = renderReportPanel(cached.report);
            } else if (cached.html) {
                html = cached.html.replace(/<button[^>]*class="[^"]*ec-btn-rerun[^"]*"[^>]*>[\s\S]*?<\/button>/gi, "");
            }
            if (html) {
                resultsContainer.innerHTML = html;
                resultsContainer.style.display = "block";
                bindPanel(resultsContainer);
            }
        }
        setStatus("Analysis complete");
        showSummaryBadge(cached.summary);
        ensureInterstitial();
    }

    async function startAnalysis(messageId, email, options = {}) {
        const forceRerun = !!options.forceRerun;
        await ensureModalInjected();

        chrome.storage.sync.get({ accountsAuthState: {}, checks: {} }, async (items) => {
            const state = items.accountsAuthState[email] || {};

            // 1. Check if Blocked
            if (state.status === 'blocked' && state.dontAskAgain) {
                setStatus('Analysis disabled for this account.');
                setBadge(BADGES.off, openPanel);
                showNotice({
                    title: 'Checks are off for this account',
                    sub: `You chose not to be asked again for ${email}. Reset that on the extension's options page to check emails here.`,
                });
                return;
            }

            // 2. Local Cache Check: If not forcing a rerun, restore immediately from local cache
            if (!forceRerun) {
                const cache = await getCache();
                const cached = await cache.getCachedAnalysis(messageId);
                if (cached && (cached.html || cached.results)) {
                    console.log("EmailChecker: Restored from persistent local cache for message:", messageId);
                    await restoreCachedUI(cached);
                    return; // No backend contact needed!
                }
            }

            // 3. Strict Authorization Check
            if (state.status !== 'authorized') {
                setBadge(BADGES.auth, () => injectAuthModal(email, state, messageId));
                return;
            }

            // 4. Abort any in-flight analysis BEFORE starting a new one
            if (currentAbortController) {
                currentAbortController.abort();
                currentAbortController = null;
            }

            // 5. If Authorized, render live checking checklist immediately!
            setStatus(forceRerun ? "Re-running analysis…" : "Checking email…");
            setBadge(BADGES.checking, openPanel);

            currentSessionId = crypto.randomUUID();
            currentAbortController = new AbortController();

            try {
                const analysisCoreUrl = chrome.runtime.getURL('core/analysis-core.js');
                const { initializeUI } = await import(analysisCoreUrl);
                const resultsContainer = document.getElementById("results-container");
                if (resultsContainer) {
                    initializeUI(resultsContainer.id, currentSessionId, items.checks);
                }
            } catch (err) {
                console.error("EmailChecker: Failed to initialize live UI:", err);
            }

            // 6. Request raw message EML from background worker
            chrome.runtime.sendMessage({ type: 'GET_RAW_MESSAGE', messageId, email });
        });
    }

    function findUserEmailFromDOM() {
        const title = document.title;
        const titleMatch = title.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)\s+-\s+Gmail$/);
        if (titleMatch && titleMatch[1]) {
            return titleMatch[1].toLowerCase();
        }

        const accountButton = document.querySelector('a[href^="https://accounts.google.com/SignOutOptions"]');
        if (accountButton) {
            const label = accountButton.getAttribute('aria-label');
            if (label) {
                const emailMatch = label.match(/\(([^)]+)\)$/);
                if (emailMatch && emailMatch[1] && emailMatch[1].includes('@')) {
                    return emailMatch[1].toLowerCase();
                }
            }
        }
        return null;
    }

    chrome.runtime.onMessage.addListener(async (request) => {
        if (request.type === 'EML_DATA') {
            // Ignore stale responses from a different email
            if (request.messageId && request.messageId !== currentMessageId) {
                console.log("Ignoring stale EML_DATA for", request.messageId, "current is", currentMessageId);
                return;
            }

            setStatus("Analyzing email…");

            chrome.storage.sync.get({ checks: {} }, async (items) => {
                const analysisCoreUrl = chrome.runtime.getURL('core/analysis-core.js');
                try {
                    const { streamAnalysis } = await import(analysisCoreUrl);
                    await streamAnalysis(request.eml, items.checks, {
                        signal: currentAbortController?.signal,
                        sessionId: currentSessionId,
                        emailKey: currentMessageId,
                        forceRerun: false,
                    });
                } catch (error) {
                    if (error.name === 'AbortError') {
                        console.log('EmailChecker: Analysis aborted.');
                        return;
                    }
                    console.error("EmailChecker: Streaming error:", error);
                    setStatus("Analysis failed");
                    setBadge(BADGES.error, openPanel);
                    const { showAnalysisError } = await import(analysisCoreUrl);
                    showAnalysisError("results-container", error.message, currentSessionId);
                }
            });

        } else if (request.type === 'EML_ERROR') {
            if (request.error === 'WRONG_ACCOUNT') {
                setStatus(`Incorrect account. Please authenticate ${request.email}.`);
                setBadge({ ...BADGES.error, sub: 'wrong Google account' }, openPanel);
                showNotice({
                    title: "We couldn't check this email",
                    sub: `Access was granted by a different Google account. Authenticate ${request.email} to check emails in this inbox.`,
                });
                return;
            }

            if (request.error === 'AUTH_REQUIRED') {
                // Allow re-analysis after auth - remove from cache if present
                if (currentMessageId) {
                    getCache().then(c => c.removeCachedAnalysis(currentMessageId)).catch(() => {});
                }
                const email = request.email || currentUserEmail;
                setStatus("Permission needed");
                setBadge(BADGES.auth, () => injectAuthModal(email, {}, currentMessageId));

                if (email) {
                    chrome.storage.sync.get({ accountsAuthState: {} }, (items) => {
                        const state = items.accountsAuthState[email] || {};

                        if (state.status === 'blocked' && state.dontAskAgain) {
                            setStatus('Analysis disabled.');
                            setBadge(BADGES.off, openPanel);
                            return;
                        }

                        injectAuthModal(email, state, currentMessageId);
                    });
                } else {
                    injectAuthModal(request.email, {}, currentMessageId);
                }
            } else {
                let cleanSub = (request.error || "")
                    .replace(/:\s*Failed to fetch/gi, "")
                    .replace(/^Error:\s*/i, "")
                    .trim();
                setStatus("Could not check email");
                setBadge(BADGES.error, openPanel);
                showNotice({ title: "We couldn't check this email", sub: cleanSub || "Unable to reach backend service" });
            }
        } else if (request.type === 'AUTH_SUCCESS') {
            const authOverlay = document.querySelector('.auth-modal-overlay');
            if (authOverlay) authOverlay.style.display = 'none';

            // Clear cache for current message so re-analysis can proceed
            if (currentMessageId) {
                getCache().then(c => c.removeCachedAnalysis(currentMessageId)).catch(() => {});
            }

            setStatus("Auth successful! Continuing...");
            setBadge(BADGES.checking, openPanel);
            if (currentUserEmail) {
                chrome.storage.sync.get({ accountsAuthState: {} }, (items) => {
                    const updated = items.accountsAuthState || {};
                    updated[currentUserEmail] = { status: 'authorized', lastAuthTime: Date.now() };
                    chrome.storage.sync.set({ accountsAuthState: updated }, () => {
                        if (currentMessageId) {
                            startAnalysis(currentMessageId, currentUserEmail);
                        }
                    });
                });
            }
        }
    });

    document.addEventListener('analysisComplete', async (e) => {
        const { sessionId, verdict, pct, badge, interstitial, report, results, html } = e.detail;
        if (sessionId && currentSessionId && sessionId !== currentSessionId) return;

        const summary = { verdict, pct, badge, interstitial };

        // Cache the analysis results in persistent local cache for this messageId
        if (currentMessageId) {
            const cache = await getCache();
            const resultsContainer = document.getElementById("results-container");
            const finalHtml = html || (resultsContainer ? resultsContainer.innerHTML : '');
            await cache.saveCachedAnalysis(currentMessageId, {
                html: finalHtml,
                summary,
                report: report || null,
                results: results || null,
                dismissed: false,
            });
        }

        // Reset any spinning rerun buttons
        document.querySelectorAll('.ec-pane-rerun').forEach(btn => btn.classList.remove('is-running'));

        // The panel never opens by itself: the badge and the scam warning lead to it.
        showSummaryBadge(summary);
        ensureInterstitial();
    });

    document.addEventListener('analysisFailed', (e) => {
        const { sessionId } = e.detail;
        if (sessionId && currentSessionId && sessionId !== currentSessionId) return;
        document.querySelectorAll('.ec-pane-rerun').forEach(btn => btn.classList.remove('is-running'));
        setBadge(BADGES.error, openPanel);
    });

    async function handleRerunRequest() {
        if (!currentMessageId || !currentUserEmail) return;
        console.log("EmailChecker: User triggered rerun for message:", currentMessageId);

        const cache = await getCache();
        await cache.removeCachedAnalysis(currentMessageId);

        setStatus("Re-running analysis…");
        setBadge(BADGES.checking, openPanel);

        document.querySelectorAll('.ec-pane-rerun').forEach(btn => btn.classList.add('is-running'));

        startAnalysis(currentMessageId, currentUserEmail, { forceRerun: true });
    }

    document.addEventListener('requestRerun', (e) => {
        e.stopPropagation();
        handleRerunRequest();
    });

    ensureModalInjected();
    new MutationObserver(() => {
        const email = findUserEmailFromDOM();
        let targetMessageElement = null;
        let targetFromElement = null;

        if (email) {
            const legacyElements = Array.from(document.querySelectorAll('[data-legacy-message-id]')).reverse();
            for (const legacyEl of legacyElements) {
                let container = legacyEl.closest('[role="listitem"], .h7, .kv, .zE, .adn');
                if (!container && legacyEl.parentElement) {
                    container = legacyEl.parentElement.parentElement;
                }
                if (container) {
                    const gdEl = container.querySelector('.gD');
                    if (gdEl) {
                        const senderEmail = gdEl.getAttribute('email');
                        if (senderEmail && senderEmail.toLowerCase() !== email.toLowerCase()) {
                            targetMessageElement = legacyEl;
                            targetFromElement = gdEl;
                            break;
                        }
                    }
                }
            }

            // Fallback to original logic if we couldn't properly pair them up
            if (!targetMessageElement || !targetFromElement) {
                targetMessageElement = document.querySelector('[data-legacy-message-id]');
                targetFromElement = document.querySelector('.gD');
            }
        }

        if (targetMessageElement && targetFromElement && email) {
            const messageId = targetMessageElement.getAttribute('data-legacy-message-id');
            if (messageId !== currentMessageId || email !== currentUserEmail) {
                // Abort any in-flight analysis for the old email IMMEDIATELY
                if (currentAbortController) {
                    currentAbortController.abort();
                    currentAbortController = null;
                }

                currentMessageId = messageId;
                currentUserEmail = email;
                currentFromElement = targetFromElement;

                // Clear any existing badges and warnings to maintain a clean UI state
                document.querySelectorAll('.ec-badge').forEach(el => el.remove());
                clearInterstitial();

                chrome.storage.sync.get({ analysisMode: 'auto' }, async (items) => {
                    injectBadge(targetFromElement);

                    // 1. If this email is already cached, preload the badge and results immediately!
                    const cache = await getCache();
                    const cached = cache.getCachedAnalysisSync(messageId) || await cache.getCachedAnalysis(messageId);

                    if (cached && (cached.html || cached.results)) {
                        console.log("EmailChecker: Preloading cached result for message:", messageId);
                        await restoreCachedUI(cached);
                        return;
                    }

                    // 2. Not cached: check mode
                    if (items.analysisMode === 'auto') {
                        setBadge(BADGES.checking, openPanel);
                        startAnalysis(messageId, email);
                    } else {
                        setBadge(BADGES.manual, () => {
                            setBadge(BADGES.checking, openPanel);
                            startAnalysis(messageId, email);
                        });
                    }
                });
            } else {
                currentFromElement = targetFromElement;
                if (!document.querySelector('.ec-badge') && targetFromElement) {
                    injectBadge(targetFromElement);
                    getCache().then(cache => {
                        const cached = cache.getCachedAnalysisSync(currentMessageId);
                        if (cached && cached.summary) {
                            showSummaryBadge(cached.summary);
                        } else {
                            chrome.storage.sync.get({ analysisMode: 'auto' }, (items) => {
                                if (items.analysisMode === 'auto') {
                                    setBadge(BADGES.checking, openPanel);
                                } else {
                                    setBadge(BADGES.manual, () => {
                                        setBadge(BADGES.checking, openPanel);
                                        startAnalysis(currentMessageId, currentUserEmail);
                                    });
                                }
                            });
                        }
                    }).catch(() => {});
                }
                ensureInterstitial();
            }
        } else if (!document.querySelector('[data-legacy-message-id]') && currentMessageId) {
            // User navigated away from email view (back to inbox, etc.)
            // Reset currentMessageId so re-opening the same email will trigger analysis
            if (currentAbortController) {
                currentAbortController.abort();
                currentAbortController = null;
            }
            currentMessageId = null;
        }
    }).observe(document.body, { childList: true, subtree: true });

    function injectAuthModal(email, state, msgId) {
        let overlay = document.querySelector('.auth-modal-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'analysis-modal-overlay auth-modal-overlay';
            const content = document.createElement('div');
            content.className = 'analysis-modal-content';
            content.style.maxWidth = '450px';
            content.style.padding = '20px';
            content.style.textAlign = 'center';
            const link = document.createElement('link');
            link.href = chrome.runtime.getURL('core/shared-styles.css');
            link.type = 'text/css';
            link.rel = 'stylesheet';
            content.prepend(link);
            overlay.appendChild(content);
            document.body.appendChild(overlay);
        }
        const content = overlay.querySelector('.analysis-modal-content');
        content.innerHTML = `
            <h3>Authentication Required</h3>
            <p>To analyze this email, you must grant permission for:</p>
            <p><strong>${email}</strong></p>
            <label style="display:block;margin:10px 0;font-size:13px;">
                <input type="checkbox" id="auth-dont-ask" ${state.dontAskAgain ? 'checked' : ''} />
                Don't ask me again for this account
            </label>
            <button id="auth-modal-button" class="auth-button">Authenticate</button>
            <button id="auth-modal-cancel" class="cancel-button">Cancel</button>
        `;

        const style = document.createElement('style');
        style.textContent = `
            .auth-button, .cancel-button { padding: 10px 20px; border-radius: 5px; border: none; font-size: 14px; font-weight: 600; cursor: pointer; margin: 5px; }
            .auth-button { background-color: #0d8a4f; color: white; }
            .cancel-button { background-color: #ccc; color: #333; }
        `;
        content.appendChild(style);

        content.querySelector('#auth-modal-button').onclick = () => {
            overlay.style.display = 'none';
            setStatus("Waiting for Google login...");
            setBadge(BADGES.checking, openPanel);

            chrome.runtime.sendMessage({
                type: 'TRIGGER_INTERACTIVE_AUTH',
                email: email,
                messageId: msgId || currentMessageId,
                dontAskAgain: false
            });
        };
        content.querySelector('#auth-modal-cancel').onclick = () => {
            if (content.querySelector('#auth-dont-ask').checked) {
                chrome.storage.sync.get({ accountsAuthState: {} }, (items) => {
                    const updated = items.accountsAuthState || {};
                    updated[email] = { status: 'blocked', dontAskAgain: true };
                    chrome.storage.sync.set({ accountsAuthState: updated });
                });
            }
            overlay.style.display = 'none';
            setBadge(BADGES.auth, () => injectAuthModal(email, state, msgId));
        };
        overlay.style.display = 'flex';
    }
}
