chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 1. Silent Check (Auto-analysis)
    if (request.type === 'GET_RAW_MESSAGE') {
        handleGetRawMessage(request, sender);
        return true;
    }

    // 2. Interactive Trigger (User clicked "Authenticate")
    if (request.type === 'TRIGGER_INTERACTIVE_AUTH') {
        handleInteractiveAuth(request, sender);
        return true;
    }

    if (request.type === 'GET_TAB_ID') {
        sendResponse({ tabId: sender.tab && sender.tab.id });
        return;
    }
});

async function handleGetRawMessage(request, sender) {
    const email = request.email;
    const messageId = request.messageId;
    const tabId = sender.tab.id;

    try {
        // Step A: Try native auth (Cached/Primary Profile)
        try {
            const token = await getAuthToken(false);
            const data = await fetchRawMessage(email, messageId, token);
            chrome.tabs.sendMessage(tabId, { type: 'EML_DATA', eml: data });
            return; // Success!
        } catch (nativeErr) {
            // Ignore error and fall through to Step B
        }

        // Step B: Try Web Auth Flow (Silent) for specific email
        if (email) {
            const webToken = await launchAuthFlow(email, false);
            const data = await fetchRawMessage(email, messageId, webToken);
            chrome.tabs.sendMessage(tabId, { type: 'EML_DATA', eml: data });
            return; // Success!
        }

        throw new Error('AUTH_REQUIRED');

    } catch (error) {
        handleError(error, email, tabId);
    }
}

async function handleInteractiveAuth(request, sender) {
    const email = request.email;
    const messageId = request.messageId;
    const tabId = request.openerTabId || (sender.tab && sender.tab.id);

    try {
        let token;

        // If we have a specific email, use Web Flow to force that user.
        if (email) {
            token = await launchAuthFlow(email, true);
        } else {
            // Fallback for unknown email
            token = await getAuthToken(true);
        }

        const data = await fetchRawMessage(email, messageId, token);

        if (tabId) {
            chrome.tabs.sendMessage(tabId, { type: 'AUTH_SUCCESS', dontAskAgain: request.dontAskAgain });
            chrome.tabs.sendMessage(tabId, { type: 'EML_DATA', eml: data });
        }

    } catch (error) {
        handleError(error, email, tabId);
    }
}

// --- Helpers ---

function getAuthToken(interactive) {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive }, (token) => {
            if (chrome.runtime.lastError || !token) {
                reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'No token'));
            } else {
                resolve(token);
            }
        });
    });
}

function launchAuthFlow(email, interactive) {
    return new Promise((resolve, reject) => {
        const manifest = chrome.runtime.getManifest();
        const clientId = manifest.oauth2.client_id;
        const scopes = manifest.oauth2.scopes.join(' ');
        const redirectUri = chrome.identity.getRedirectURL();

        let authUrl = `https://accounts.google.com/o/oauth2/auth` +
            `?client_id=${clientId}` +
            `&response_type=token` +
            `&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&scope=${encodeURIComponent(scopes)}`;

        if (email) {
            authUrl += `&login_hint=${encodeURIComponent(email)}`;
        }

        if (interactive) {
            authUrl += `&prompt=select_account`;
        }

        chrome.identity.launchWebAuthFlow({
            url: authUrl,
            interactive: interactive
        }, (redirectUrl) => {
            if (chrome.runtime.lastError || !redirectUrl) {
                reject(chrome.runtime.lastError || new Error('Auth flow failed or closed'));
                return;
            }
            const matches = redirectUrl.match(/access_token=([^&]+)/);
            if (matches && matches[1]) {
                resolve(matches[1]);
            } else {
                reject(new Error('Invalid redirect URL'));
            }
        });
    });
}

async function fetchRawMessage(userId, messageId, token) {
    const uid = encodeURIComponent(userId || 'me');
    const url = `https://www.googleapis.com/gmail/v1/users/${uid}/messages/${messageId}?format=raw`;

    const response = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });

    if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
            throw new Error('AUTH_REQUIRED');
        }

        const errorText = await response.text();
        try {
            const parsed = JSON.parse(errorText);
            const msg = parsed?.error?.message || '';
            const delegationMatch = msg.match(/Delegation denied for ([^\s@]+@[^\s@]+)/i);
            if (delegationMatch) {
                throw new Error(`WRONG_ACCOUNT:${delegationMatch[1]}`);
            }
        } catch (e) {}

        throw new Error(`Google API Error: ${response.status}`);
    }

    const data = await response.json();
    if (data && data.raw) {
        return data.raw.replace(/-/g, '+').replace(/_/g, '/');
    }
    throw new Error("Invalid API response format.");
}

function handleError(error, email, tabId) {
    if (!tabId) return;
    const msg = error && error.message ? error.message : '';

    // Check if this is an expected auth state (not a real system error)
    const isAuthError = msg === 'AUTH_REQUIRED' ||
        msg.includes('User interaction required') ||
        msg.includes('user is not signed in') ||
        msg.includes('Auth flow failed');

    // Only log red errors for actual failures. For auth checks, just log info.
    if (!isAuthError) {
        console.error("Extension Error:", msg);
    } else {
        // Optional: Keep this for debugging, or remove it entirely for silence
        console.log("Auth Status: Authentication needed for", email, "(waiting for user input).");
    }

    if (msg.startsWith('WRONG_ACCOUNT:')) {
        const actual = msg.split(':')[1];
        chrome.tabs.sendMessage(tabId, { type: 'EML_ERROR', error: 'WRONG_ACCOUNT', email, actualEmail: actual });
        return;
    }

    if (isAuthError) {
        chrome.tabs.sendMessage(tabId, { type: 'EML_ERROR', error: 'AUTH_REQUIRED', email });
    } else {
        chrome.tabs.sendMessage(tabId, { type: 'EML_ERROR', error: msg });
    }
}