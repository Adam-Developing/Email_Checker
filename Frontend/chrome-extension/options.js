// Default settings
const DEFAULT_SETTINGS = {
    analysisMode: 'auto',
    checks: {
        checkDomain: true,
        checkUrls: true,
        checkAttachments: true,
        checkTextAnalysis: true,
        checkRenderedAnalysis: true,
    },
    accountsAuthState: {}
};

// Helper to handle the status bar animation
function showStatus(message, duration = 1500) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.classList.add('visible');

    // Clear timeout if one exists to prevent overlaps
    if (status.timeoutId) clearTimeout(status.timeoutId);

    status.timeoutId = setTimeout(() => {
        status.classList.remove('visible');
    }, duration);
}

function applyChecks(checks) {
    document.getElementById('checkDomain').checked = checks.checkDomain;
    document.getElementById('checkUrls').checked = checks.checkUrls;
    document.getElementById('checkAttachments').checked = checks.checkAttachments;
    document.getElementById('checkTextAnalysis').checked = checks.checkTextAnalysis;
    document.getElementById('checkRenderedAnalysis').checked = checks.checkRenderedAnalysis;
}

function renderAccounts(accountsAuthState) {
    const container = document.getElementById('accounts-list');
    container.innerHTML = '';

    const entries = Object.entries(accountsAuthState || {});
    if (entries.length === 0) {
        const msg = document.createElement('div');
        msg.textContent = 'No account data yet. Authorisation prompts will appear when needed.';
        msg.style.cssText = 'font-size: 0.875rem; color: #94a3b8; font-style: italic;';
        container.appendChild(msg);
        return;
    }

    entries.forEach(([email, state]) => {
        const row = document.createElement('div');
        // Inline styles to match the new "Card" aesthetic
        row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 0; border-bottom: 1px solid #f1f5f9; font-size: 0.875rem;';

        const label = document.createElement('div');
        label.style.color = '#334155';
        const status = state.status || 'unknown';
        const dontAsk = state.dontAskAgain ? ' - (don\'t ask again)' : '';
        label.innerHTML = `<strong>${email}</strong> <span style="font-size: 0.75rem; color: #94a3b8">(${status}${dontAsk})</span>`;

        const btn = document.createElement('button');
        btn.textContent = 'Reset';
        // Override global full-width button style for this specific button
        btn.style.cssText = 'width: auto; padding: 0.25rem 0.75rem; font-size: 0.75rem; color: #dc2626; background: #fef2f2; border-radius: 4px; border: 1px solid #fee2e2;';

        btn.addEventListener('click', () => {
            chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
                const updated = items.accountsAuthState || {};
                delete updated[email];
                chrome.storage.sync.set({ accountsAuthState: updated }, () => {
                    showStatus('Account authorisation reset.');
                    renderAccounts(updated);
                });
            });
        });

        row.appendChild(label);
        row.appendChild(btn);
        container.appendChild(row);
    });
}

// Saves options to chrome.storage
function saveOptions() {
    // Only proceed if the DOM is fully loaded (safeguard)
    const modeInput = document.querySelector('input[name="analysisMode"]:checked');
    if (!modeInput) return;

    const selectedMode = modeInput.value;
    const checks = {
        checkDomain: document.getElementById('checkDomain').checked,
        checkUrls: document.getElementById('checkUrls').checked,
        checkAttachments: document.getElementById('checkAttachments').checked,
        checkTextAnalysis: document.getElementById('checkTextAnalysis').checked,
        checkRenderedAnalysis: document.getElementById('checkRenderedAnalysis').checked,
    };

    chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
        const accountsAuthState = items.accountsAuthState || {};
        chrome.storage.sync.set({ analysisMode: selectedMode, checks, accountsAuthState }, () => {
            showStatus('Options saved.');
        });
    });
}

// Restores select box and checkbox state using the preferences
function restoreOptions() {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
        const mode = items.analysisMode || DEFAULT_SETTINGS.analysisMode;
        const radioButton = document.querySelector(`input[name="analysisMode"][value="${mode}"]`);
        if (radioButton) radioButton.checked = true;

        applyChecks({ ...DEFAULT_SETTINGS.checks, ...items.checks });
        renderAccounts(items.accountsAuthState || {});
    });
}

function initOptionsPage() {
    restoreOptions();

    // Attach change listeners to all inputs for auto-saving
    document.querySelectorAll('input').forEach((input) => {
        input.addEventListener('change', saveOptions);
    });

    const clearBtn = document.getElementById('clear-accounts');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            chrome.storage.sync.set({ accountsAuthState: {} }, () => {
                renderAccounts({});
                showStatus('All account authorisation data cleared.');
            });
        });
    }

    const clearTokensBtn = document.getElementById('clear-google-tokens');
    if (clearTokensBtn && chrome.identity && chrome.identity.clearAllCachedAuthTokens) {
        clearTokensBtn.addEventListener('click', () => {
            chrome.identity.clearAllCachedAuthTokens(() => {
                showStatus('Google OAuth tokens cleared.');
            });
        });
    }
}

document.addEventListener('DOMContentLoaded', initOptionsPage);