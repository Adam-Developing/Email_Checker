/* global document, chrome */

if (window.top === window.self) {

    // Cache completed analysis results keyed by messageId, so revisiting
    // an email can restore the UI without re-fetching.
    let analysisCache = new Map(); // messageId -> { html, scoreData }
    let currentMessageId = null;
    let currentUserEmail = null;
    let currentSessionId = null;
    let currentAbortController = null;

    async function injectModalContainer() {
        if (document.querySelector('.analysis-modal-overlay')) return;
        const overlay = document.createElement('div');
        overlay.className = 'analysis-modal-overlay';
        overlay.style.display = 'none';
        overlay.onclick = (e) => { if (e.target === overlay) overlay.style.display = 'none'; };

        const content = document.createElement('div');
        content.className = 'analysis-modal-content';
        const closeButton = document.createElement('span');
        closeButton.className = 'analysis-modal-close';
        closeButton.innerHTML = '&times;';
        closeButton.onclick = () => { overlay.style.display = 'none'; };

        const uiUrl = chrome.runtime.getURL('analysis-ui.html');
        try {
            const response = await fetch(uiUrl);
            content.innerHTML = await response.text();
        } catch (error) {
            content.innerHTML = '<p>Error loading UI.</p>';
        }

        content.prepend(closeButton);
        overlay.appendChild(content);
        document.body.appendChild(overlay);

        const link = document.createElement('link');
        link.href = chrome.runtime.getURL('core/shared-styles.css');
        link.type = 'text/css';
        link.rel = 'stylesheet';
        content.prepend(link);
    }

    function injectScoreUI(fromElement) {
        const scoreCircle = document.createElement('div');
        scoreCircle.className = 'email-score-circle loading';
        for (let i = 0; i < 3; i++) {
            const dot = document.createElement('div');
            dot.className = 'dot';
            scoreCircle.appendChild(dot);
        }
        fromElement.appendChild(scoreCircle);

        // Default click: open the main analysis modal
        scoreCircle.onclick = (e) => {
            e.stopPropagation();
            const overlay = document.querySelector('.analysis-modal-overlay');
            if (overlay) overlay.style.display = 'flex';
        };
    }

    function startAnalysis(messageId, email) {
        chrome.storage.sync.get({ accountsAuthState: {} }, (items) => {
            const state = items.accountsAuthState[email] || {};

            // 1. Check if Blocked
            if (state.status === 'blocked' && state.dontAskAgain) {
                const statusElement = document.getElementById("item-subject");
                if (statusElement) statusElement.innerText = 'Analysis disabled for this account.';
                return;
            }

            // 2. If we have a cached result for this messageId, restore it
            if (analysisCache.has(messageId)) {
                const cached = analysisCache.get(messageId);
                const resultsContainer = document.getElementById("results-container");
                if (resultsContainer && cached.html) {
                    resultsContainer.innerHTML = cached.html;
                    resultsContainer.style.display = "block";
                }
                const statusContainer = document.getElementById("analysis-status-container");
                if (statusContainer) statusContainer.style.display = "flex";
                const statusElement = document.getElementById("item-subject");
                if (statusElement) statusElement.innerText = "Analysis complete.";
                const spinnerElement = document.getElementById("analysis-spinner");
                if (spinnerElement) spinnerElement.style.display = "none";

                // Restore the score circle from cached data
                if (cached.scoreData) {
                    restoreScoreCircle(cached.scoreData);
                }
                return;
            }

            // 3. CRITICAL FIX: Strict Authorization Check
            if (state.status !== 'authorized') {
                const scoreCircle = document.querySelector('.email-score-circle');
                if (scoreCircle) {
                    scoreCircle.classList.remove('loading');
                    scoreCircle.classList.add('low-score');
                    scoreCircle.textContent = 'Auth!';

                    scoreCircle.onclick = (e) => {
                        e.stopPropagation();
                        injectAuthModal(email, state, messageId);
                    };
                }
                return;
            }

            // 4. Abort any in-flight analysis BEFORE starting a new one
            if (currentAbortController) {
                currentAbortController.abort();
                currentAbortController = null;
            }

            // 5. If Authorized, proceed with fetch
            const analysisCoreUrl = chrome.runtime.getURL('core/analysis-core.js');
            import(analysisCoreUrl).then(({ initializeUI }) => {
                const resultsContainer = document.getElementById("results-container");
                if (resultsContainer) {
                    currentSessionId = crypto.randomUUID();
                    initializeUI(resultsContainer.id, currentSessionId);
                }
                currentAbortController = new AbortController();
                chrome.runtime.sendMessage({ type: 'GET_RAW_MESSAGE', messageId, email });
            });
        });
    }

    function restoreScoreCircle(scoreData) {
        const { pct } = scoreData;
        const scoreCircle = document.querySelector('.email-score-circle');
        if (scoreCircle) {
            scoreCircle.classList.remove('loading');
            if (pct === null) {
                scoreCircle.textContent = '--%';
                scoreCircle.classList.remove('low-score', 'medium-score', 'high-score');
            } else {
                scoreCircle.textContent = `${pct.toFixed(0)}%`;
                scoreCircle.classList.remove('low-score', 'medium-score', 'high-score');
                scoreCircle.classList.add(pct < 40 ? 'low-score' : pct < 70 ? 'medium-score' : 'high-score');
            }
        }
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
            const analysisModuleUrl = chrome.runtime.getURL('core/analysis-ui-flow.js');
            const {handleAnalysisFlow} = await import(analysisModuleUrl);
            const uiElements = {
                statusElement: document.getElementById("item-subject"),
                spinnerElement: document.getElementById("analysis-spinner"),
                resultsContainer: document.getElementById("results-container"),
                statusContainer: document.getElementById("analysis-status-container")
            };
            chrome.storage.sync.get({ checks: {} }, (items) => {
                const sessionId = currentSessionId || crypto.randomUUID();
                handleAnalysisFlow(
                    () => Promise.resolve(request.eml),
                    items.checks,
                    uiElements,
                    () => {},
                    sessionId,
                    currentAbortController
                ).catch(err => console.error(err));
            });

        } else if (request.type === 'EML_ERROR') {
            if (request.error === 'WRONG_ACCOUNT') {
                const statusElement = document.getElementById('item-subject');
                if (statusElement) statusElement.innerText = `Incorrect account. Please authenticate ${request.email}.`;
                return;
            }

            if (request.error === 'AUTH_REQUIRED') {
                // Allow re-analysis after auth - remove from cache if present
                if (currentMessageId) analysisCache.delete(currentMessageId);
                const email = request.email || currentUserEmail;

                if (email) {
                    chrome.storage.sync.get({ accountsAuthState: {} }, (items) => {
                        const state = items.accountsAuthState[email] || {};

                        if (state.status === 'blocked' && state.dontAskAgain) {
                            const statusElement = document.getElementById("item-subject");
                            if (statusElement) statusElement.innerText = 'Analysis disabled.';
                            return;
                        }

                        injectAuthModal(email, state, currentMessageId);
                        const scoreCircle = document.querySelector('.email-score-circle');
                        if (scoreCircle) {
                            scoreCircle.classList.remove('loading');
                            scoreCircle.classList.add('low-score');
                            scoreCircle.textContent = 'Auth!';
                            scoreCircle.onclick = (e) => {
                                e.stopPropagation();
                                injectAuthModal(email, state, currentMessageId);
                            };
                        }
                    });
                } else {
                    injectAuthModal(request.email, {}, currentMessageId);
                }
            } else {
                const statusElement = document.getElementById("item-subject");
                if (statusElement) statusElement.innerText = `Error: ${request.error}`;
                const scoreCircle = document.querySelector('.email-score-circle');
                if (scoreCircle) {
                    scoreCircle.classList.remove('loading');
                    scoreCircle.classList.add('low-score');
                    scoreCircle.textContent = 'Err';
                }
            }
        } else if (request.type === 'AUTH_SUCCESS') {
            const authOverlay = document.querySelector('.auth-modal-overlay');
            if (authOverlay) authOverlay.style.display = 'none';

            // Clear cache for current message so re-analysis can proceed
            if (currentMessageId) analysisCache.delete(currentMessageId);

            const statusElement = document.getElementById("item-subject");
            if (statusElement) statusElement.innerText = "Auth successful! Continuing...";
            const scoreCircle = document.querySelector('.email-score-circle');
            if (scoreCircle) {
                scoreCircle.className = 'email-score-circle loading';
                scoreCircle.textContent = '';
                // Restore default click behavior
                scoreCircle.onclick = (e) => {
                    e.stopPropagation();
                    const overlay = document.querySelector('.analysis-modal-overlay');
                    if (overlay) overlay.style.display = 'flex';
                };
                for(let i=0; i<3; i++) scoreCircle.appendChild(document.createElement('div')).className = 'dot';
            }
            if (currentUserEmail) {
                chrome.storage.sync.get({ accountsAuthState: {} }, (items) => {
                    const updated = items.accountsAuthState || {};
                    updated[currentUserEmail] = { status: 'authorized', lastAuthTime: Date.now() };
                    chrome.storage.sync.set({ accountsAuthState: updated });
                });
            }
        }
    });

    document.addEventListener('analysisComplete', (e) => {
        const { normalScore, renderedScore, maxScore, sessionId } = e.detail;
        if (sessionId && currentSessionId && sessionId !== currentSessionId) return;

        const checks = (window.latestExtensionChecks || {});
        const anyCheckEnabled = Object.values(checks).some(val => val === true);

        let pct = null;

        if (anyCheckEnabled) {
            const nPct = Math.max(0, Math.min(100, (normalScore / maxScore) * 100));
            const rPct = Math.max(0, Math.min(100, (renderedScore / maxScore) * 100));
            pct = (nPct + rPct) / 2;
        }

        // Cache the analysis results for this messageId
        if (currentMessageId) {
            const resultsContainer = document.getElementById("results-container");
            analysisCache.set(currentMessageId, {
                html: resultsContainer ? resultsContainer.innerHTML : '',
                scoreData: { pct }
            });

            // Limit cache size to prevent unbounded growth (LRU: remove oldest)
            if (analysisCache.size > 50) {
                const firstKey = analysisCache.keys().next().value;
                analysisCache.delete(firstKey);
            }
        }

        const scoreCircle = document.querySelector('.email-score-circle');
        if (scoreCircle) {
            scoreCircle.classList.remove('loading');
            if (pct === null) {
                scoreCircle.textContent = '--%';
                scoreCircle.classList.remove('low-score', 'medium-score', 'high-score');
            } else {
                scoreCircle.textContent = `${pct.toFixed(0)}%`;
                scoreCircle.classList.remove('low-score', 'medium-score', 'high-score');
                scoreCircle.classList.add(pct < 40 ? 'low-score' : pct < 70 ? 'medium-score' : 'high-score');
                if(pct < 40) {
                    const overlay = document.querySelector('.analysis-modal-overlay');
                    if(overlay) overlay.style.display = 'flex';
                }
            }
        }
    });

    injectModalContainer();
    new MutationObserver(() => {
        const messageElement = document.querySelector('[data-legacy-message-id]');
        const email = findUserEmailFromDOM();
        if (messageElement && email) {
            const messageId = messageElement.getAttribute('data-legacy-message-id');
            if (messageId !== currentMessageId || email !== currentUserEmail) {
                // Abort any in-flight analysis for the old email IMMEDIATELY
                if (currentAbortController) {
                    currentAbortController.abort();
                    currentAbortController = null;
                }

                currentMessageId = messageId;
                currentUserEmail = email;
                const oldCircle = document.querySelector('.email-score-circle');
                if (oldCircle) oldCircle.remove();
                const oldButton = document.querySelector('.manual-check-button');
                if (oldButton) oldButton.remove();

                const fromElement = document.querySelector('.gD');
                if (fromElement) {
                    chrome.storage.sync.get({ analysisMode: 'auto' }, (items) => {
                        if (items.analysisMode === 'auto') {
                            injectScoreUI(fromElement);
                            startAnalysis(messageId, email);
                        } else {
                            injectManualCheckButton(fromElement, messageId, email);
                        }
                    });
                }
            }
        } else if (!messageElement && currentMessageId) {
            // User navigated away from email view (back to inbox, etc.)
            // Reset currentMessageId so re-opening the same email will trigger analysis
            if (currentAbortController) {
                currentAbortController.abort();
                currentAbortController = null;
            }
            currentMessageId = null;
        }
    }).observe(document.body, { childList: true, subtree: true });

    function injectManualCheckButton(fromElement, messageId, email) {
        if (fromElement.querySelector('.manual-check-button')) return;
        const btn = document.createElement('div');
        btn.className = 'email-score-circle high-score manual-check-button';
        btn.textContent = 'Check';
        btn.style.fontSize = '12px';
        btn.onclick = (e) => {
            e.stopPropagation();
            btn.remove();
            injectScoreUI(fromElement);
            startAnalysis(messageId, email);
        };
        fromElement.appendChild(btn);
    }

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
            const mainOverlay = document.querySelector('.analysis-modal-overlay:not(.auth-modal-overlay)');
            if (mainOverlay) mainOverlay.style.display = 'flex';
            const statusElement = document.getElementById("item-subject");
            if (statusElement) statusElement.innerText = "Waiting for Google login...";

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
            const sc = document.querySelector('.email-score-circle');
            if(sc) { sc.classList.remove('loading'); sc.classList.add('low-score'); sc.textContent = 'Auth!'; }
        };
        overlay.style.display = 'flex';
    }
}