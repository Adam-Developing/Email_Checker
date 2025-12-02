/* global document, chrome */

if (window.top === window.self) {

    let analyzedMessageIds = new Set();
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

            if (analyzedMessageIds.has(messageId)) return;

            // 2. CRITICAL FIX: Strict Authorization Check
            // If the user is NOT marked 'authorized' (e.g. new user or reset in options),
            // DO NOT try to fetch silently. Force the Auth UI immediately.
            if (state.status !== 'authorized') {
                const scoreCircle = document.querySelector('.email-score-circle');
                if (scoreCircle) {
                    scoreCircle.classList.remove('loading');
                    scoreCircle.classList.add('low-score');
                    scoreCircle.textContent = 'Auth!';

                    // Override click to open Auth Modal instead of empty results
                    scoreCircle.onclick = (e) => {
                        e.stopPropagation();
                        injectAuthModal(email, state, messageId);
                    };
                }
                return; // Stop here. Do not fetch data.
            }

            // 3. If Authorized, proceed with silent fetch
            analyzedMessageIds.add(messageId);

            const analysisCoreUrl = chrome.runtime.getURL('core/analysis-core.js');
            import(analysisCoreUrl).then(({ initializeUI }) => {
                const resultsContainer = document.getElementById("results-container");
                if (resultsContainer) {
                    currentSessionId = crypto.randomUUID();
                    initializeUI(resultsContainer.id, currentSessionId);
                }
                if (currentAbortController) currentAbortController.abort();
                currentAbortController = new AbortController();
                chrome.runtime.sendMessage({ type: 'GET_RAW_MESSAGE', messageId, email });
            });
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
                if (currentMessageId) analyzedMessageIds.delete(currentMessageId);
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
        // Check if ANY check is enabled (values in checks object are booleans)
        const anyCheckEnabled = Object.values(checks).some(val => val === true);

        let pct = null;

        if (anyCheckEnabled) {
            // Even if text/rendered checks are disabled, normalScore/renderedScore
            // will contain the Base score (Domain/URL/Attachment).
            const nPct = Math.max(0, Math.min(100, (normalScore / maxScore) * 100));
            const rPct = Math.max(0, Math.min(100, (renderedScore / maxScore) * 100));
            // Show the average of the available pipelines
            pct = (nPct + rPct) / 2;
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