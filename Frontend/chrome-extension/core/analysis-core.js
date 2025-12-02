/* global document */

// --- Global State ---
let currentScores = {
    normal: 0,
    rendered: 0,
    base: 0,
    max: 100,
    sessionId: null,
};

let activeSessionId = null;

let urlScanState = {
    total: 0,
    completed: 0
};

const DEFAULT_CHECKS = {
    checkDomain: true,
    checkUrls: true,
    checkAttachments: true,
    checkTextAnalysis: true,
    checkRenderedAnalysis: true,
};

let latestChecks = { ...DEFAULT_CHECKS };

function mergeChecks(settings = {}) {
    const merged = { ...DEFAULT_CHECKS, ...(settings?.checks || settings) };
    latestChecks = merged;
    if (typeof window !== 'undefined') {
        window.latestExtensionChecks = merged;
    }
    return merged;
}

function shouldRender(checkKey) {
    return !!latestChecks[checkKey];
}

function applyDisabledStates() {
    const cards = [
        { key: 'checkDomain', elementId: 'cell-domain', message: 'Domain check is disabled.' },
        { key: 'checkUrls', elementId: 'cell-url', message: 'URL scan is disabled.' },
        { key: 'checkAttachments', elementId: 'cell-attachments', message: 'Attachment scan is disabled.' },
        { key: 'checkTextAnalysis', elementId: 'cell-text-summary', message: 'Text analysis is disabled.' },
        { key: 'checkRenderedAnalysis', elementId: 'cell-rendered-summary', message: 'Rendered analysis is disabled.' },
    ];

    cards.forEach(({ key, elementId, message }) => {
        if (!shouldRender(key)) {
            const el = document.getElementById(elementId);
            if (el) {
                el.innerHTML = `<div class="disabled-check">${message}</div>`;
            }
        }
    });

    // Disable deeper analysis table cells, but NOT the main score cards
    if (!shouldRender('checkTextAnalysis')) {
        const textIds = [
            'cell-text-phone',
            'cell-text-company',
            'cell-text-verification',
            'cell-text-realism',
            'cell-text-action'
        ];
        textIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.innerHTML = '<div class="disabled-check">Text analysis disabled in settings.</div>';
            }
        });
    }

    if (!shouldRender('checkRenderedAnalysis')) {
        const renderedIds = [
            'cell-rendered-phone',
            'cell-rendered-company',
            'cell-rendered-verification',
            'cell-rendered-realism',
            'cell-rendered-action'
        ];
        renderedIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.innerHTML = '<div class="disabled-check">Rendered analysis disabled in settings.</div>';
            }
        });
    }
}

export async function streamAnalysis(emlData, settings, options = {}) {
    const { signal, sessionId } = options;
    const enabledChecks = mergeChecks(settings);
    activeSessionId = sessionId || crypto.randomUUID();
    currentScores.sessionId = activeSessionId;

    const url = new URL("http://127.0.0.1:8080/process-eml-stream");

    if (settings) {
        Object.entries(enabledChecks).forEach(([key, value]) => {
            url.searchParams.append(key, value ? "true" : "false");
        });
    }

    let response;
    try {
        response = await fetch(url.href, {
            method: "POST",
            headers: {
                "Content-Type": "text/plain;charset=UTF-8"
            },
            body: emlData,
            signal,
        });
    } catch (error) {
        if (error.name === "AbortError") {
            throw error;
        }
        throw new Error(`Unable to reach backend service: ${error.message}`);
    }

    if (!response.ok) {
        throw new Error(`Server error: ${response.status} ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();

        for (const part of parts) {
            processSSEMessage(part, activeSessionId);
        }
    }
    if (buffer.trim()) {
        processSSEMessage(buffer, activeSessionId);
    }
}
function processSSEMessage(message, sessionId) {
    const lines = message.split('\n');
    let eventName = '';
    let dataJson = '';

    for (const line of lines) {
        if (line.startsWith('event: ')) {
            eventName = line.substring(7).trim();
        } else if (line.startsWith('data: ')) {
            dataJson = line.substring(6).trim();
        }
    }

    if (eventName && dataJson) {
        try {
            const payload = JSON.parse(dataJson);
            handleStreamEvent(eventName, payload, sessionId);
        } catch (error) {
            console.error("Failed to parse SSE data:", dataJson, error);
        }
    }
}

const eventHandlers = {
    'maxScore': (payload) => {
        currentScores.max = payload.maxScore;
        applyDisabledStates();
    },
    'domainAnalysis': (payload) => {
        if (!shouldRender('checkDomain')) return;
        currentScores.base += payload.scoreImpact;
        updateDomainUI(payload);
        updateScoresUI();
    },
    'urlScanStarted': (payload) => {
        if (!shouldRender('checkUrls')) return;
        urlScanState.total = payload.total;
        urlScanState.completed = 0;
        const summaryEl = document.getElementById('url-scan-summary');
        const resultsListEl = document.getElementById('url-scan-results-list');

        if (summaryEl) {
            if (payload.total > 0) {
                summaryEl.innerHTML = `<div>Scanning ${payload.total} URL(s)...</div>`;
            } else {
                summaryEl.innerHTML = `<div>No URLs found to scan.</div>`;
            }
        }
        if (resultsListEl) {
            resultsListEl.innerHTML = '';
        }
    },
    'urlScanResult': (payload) => {
        if (!shouldRender('checkUrls')) return;
        urlScanState.completed++;
        const summaryEl = document.getElementById('url-scan-summary');
        if (summaryEl) {
            summaryEl.innerHTML = `<div>Scanned ${urlScanState.completed} of ${urlScanState.total} URL(s)...</div>`;
        }

        const listEl = document.getElementById('url-scan-results-list');
        if (listEl) {
            const li = document.createElement('li');
            const isMalicious = payload.finalDecision;

            if (payload.error) {
                li.className = 'url-error';
                li.innerHTML = `⚠️ <strong>Error scanning:</strong> ${payload.url}`;
            } else if (isMalicious) {
                li.className = 'url-malicious';
                li.innerHTML = `🚨 <strong>MALICIOUS:</strong> <a href="${payload.report}" target="_blank">${payload.url}</a>`;
            } else {
                li.className = 'url-safe';
                li.innerHTML = `✅ <strong>Clean:</strong> <a href="${payload.report}" target="_blank">${payload.url}</a>`;
            }
            listEl.appendChild(li);
        }
    },
    'urlAnalysis': (payload) => {
        if (!shouldRender('checkUrls')) return;
        currentScores.base += payload.scoreImpact;
        updateUrlUI(payload);
        updateScoresUI();
    },
    'executableAnalysis': (payload) => {
        if (!shouldRender('checkAttachments')) return;
        currentScores.base += payload.scoreImpact;
        updateAttachmentsUI(payload);
        updateScoresUI();
    },
    'textAnalysis': (payload) => {
        if (!shouldRender('checkTextAnalysis')) return;
        const summaryEl = document.getElementById('cell-text-summary');
        if (payload.error) {
            console.error("Text analysis failed:", payload.error);
            if (summaryEl) summaryEl.innerHTML = `<div style="color: red;">⚠️ Analysis failed.</div>`;
            return;
        }
        updateContentAnalysisUI('text', payload);
        currentScores.normal += (payload.companyIdentification.scoreImpact || 0);
        currentScores.normal += (payload.companyVerification.scoreImpact || 0);
        currentScores.normal += (payload.realismAnalysis.scoreImpact || 0);
        currentScores.normal += (payload.contactMethodAnalysis.scoreImpact || 0);
        updateScoresUI();
    },
    'renderedAnalysis': (payload) => {
        if (!shouldRender('checkRenderedAnalysis')) return;
        const summaryEl = document.getElementById('cell-rendered-summary');
        if (payload.error) {
            console.error("Rendered analysis failed:", payload.error);
            if(summaryEl) summaryEl.innerHTML = `<div style="color: red;">⚠️ Analysis failed.</div>`;
            return;
        }
        updateContentAnalysisUI('rendered', payload);
        currentScores.rendered += (payload.companyIdentification.scoreImpact || 0);
        currentScores.rendered += (payload.companyVerification.scoreImpact || 0);
        currentScores.rendered += (payload.realismAnalysis.scoreImpact || 0);
        currentScores.rendered += (payload.contactMethodAnalysis.scoreImpact || 0);
        updateScoresUI();
    },
    'finalScores': (payload) => {
        console.log("Final scores received from backend:", payload);
        updateScoresUI(payload);
    }
};

function handleStreamEvent(eventName, payload, sessionId) {
    if (sessionId && activeSessionId && sessionId !== activeSessionId) {
        return; // Ignore stale responses
    }
    console.log(`Received event: ${eventName}`, payload);
    const handler = eventHandlers[eventName];
    if (handler) {
        handler(payload);
    } else {
        console.warn(`No handler for event: ${eventName}`);
    }
}

// --- UI Update Functions ---

export function initializeUI(containerId, sessionId, settings = {}) {
    mergeChecks(settings);
    currentScores = { normal: 0, rendered: 0, base: 0, max: 100, sessionId };
    activeSessionId = sessionId || activeSessionId;
    const container = document.getElementById(containerId);
    if (!container) return;
    container.style.display = "block";
    container.innerHTML = `
        <div class="analysis-container">
            <div class="verdict-grid">
                <div class="verdict-card">
                    <h3>📝 Text Analysis Score</h3>
                    <div class="progress-bar">
                        <div id="text-progress-bar" class="progress-bar-inner" style="width: 0%;"></div>
                    </div>
                    <p id="text-score-text" class="score-text">Calculating... (0%)</p>
                </div>
                <div class="verdict-card">
                    <h3>🖼️ Rendered Analysis Score</h3>
                    <div class="progress-bar">
                        <div id="rendered-progress-bar" class="progress-bar-inner" style="width: 0%;"></div>
                    </div>
                    <p id="rendered-score-text" class="score-text">Calculating... (0%)</p>
                </div>
            </div>
            <div class="universal-checks-container">
                <h3>Initial Email Checks</h3>
                <div class="universal-check-card" id="universal-summary">
                    <h4>📝 Summary</h4>
                    <div>
                        <p><strong>Text Analysis:</strong></p>
                        <div id="cell-text-summary"><div class="loading-placeholder"><div class="spinner"></div></div></div>
                        <hr>
                        <p><strong>Rendered Analysis:</strong></p>
                        <div id="cell-rendered-summary"><div class="loading-placeholder"><div class="spinner"></div></div></div>
                    </div>
                </div>
                <div class="universal-check-card" id="universal-domain">
                    <h4>🛡️ Sender Domain</h4>
                    <div id="cell-domain"><div class="loading-placeholder"><div class="spinner"></div>Waiting...</div></div>
                </div>
                <div class="universal-check-card" id="universal-url">
                     <h4>🔗 URL Scan</h4>
                     <div id="cell-url">
                        <div id="url-scan-summary" class="collapsible-header">
                            <div class="loading-placeholder"><div class="spinner"></div>Waiting...</div>
                        </div>
                        <div id="url-scan-content" class="collapsible-content">
                            <ul id="url-scan-results-list" class="url-scan-list"></ul>
                        </div>
                     </div>
                </div>
                <div class="universal-check-card" id="universal-attachments">
                     <h4>📎 Attachments</h4>
                    <div id="cell-attachments"><div class="loading-placeholder"><div class="spinner"></div>Waiting...</div></div>
                </div>
            </div>
             <h3>Deeper Analysis</h3>
            <table class="comparison-table">
                <thead>
                    <tr>
                        <th>Check</th>
                        <th>📝 Text Analysis</th>
                        <th>🖼️ Rendered Analysis</th>
                    </tr>
                </thead>
                <tbody>
                    <tr id="row-phone"><td class="category-title">📞<br>Phone Numbers</td><td id="cell-text-phone"><div class="loading-placeholder"><div class="spinner"></div></div></td><td id="cell-rendered-phone"><div class="loading-placeholder"><div class="spinner"></div></div></td></tr>
                    <tr id="row-company"><td class="category-title">🏢<br>Company Name</td><td id="cell-text-company"><div class="loading-placeholder"><div class="spinner"></div></div></td><td id="cell-rendered-company"><div class="loading-placeholder"><div class="spinner"></div></div></td></tr>
                    <tr id="row-verification"><td class="category-title">🔍<br>Verification</td><td id="cell-text-verification"><div class="loading-placeholder"><div class="spinner"></div></div></td><td id="cell-rendered-verification"><div class="loading-placeholder"><div class="spinner"></div></div></td></tr>
                    <tr id="row-realism"><td class="category-title">🧐<br>Content Realism</td><td id="cell-text-realism"><div class="loading-placeholder"><div class="spinner"></div></div></td><td id="cell-rendered-realism"><div class="loading-placeholder"><div class="spinner"></div></div></td></tr>
                    <tr id="row-action"><td class="category-title">⚡<br>Action Required</td><td id="cell-text-action"><div class="loading-placeholder"><div class="spinner"></div></div></td><td id="cell-rendered-action"><div class="loading-placeholder"><div class="spinner"></div></div></td></tr>
                </tbody>
            </table>
        </div>
    `;

    const urlHeader = document.getElementById('url-scan-summary');
    if (urlHeader) {
        urlHeader.addEventListener('click', function() {
            this.classList.toggle('active');
            const content = this.nextElementSibling;
            if (content.style.maxHeight) {
                content.style.maxHeight = null;
            } else {
                content.style.maxHeight = content.scrollHeight + "px";
            }
        });
    }
    applyDisabledStates();
}
function updateScoresUI(finalScores = null) {
    if (currentScores.sessionId && activeSessionId && currentScores.sessionId !== activeSessionId) {
        return;
    }
    const normalScore = finalScores ? finalScores.finalScoreNormal : currentScores.base + currentScores.normal;
    const renderedScore = finalScores ? finalScores.finalScoreRendered : currentScores.base + currentScores.rendered;

    if (finalScores) {
        const event = new CustomEvent('analysisComplete', {
            detail: {
                normalScore: normalScore,
                renderedScore: renderedScore,
                maxScore: currentScores.max,
                sessionId: currentScores.sessionId,
            }
        });
        document.dispatchEvent(event);
    }

    // Always calculate percentages, even if checks are disabled (falling back to Base score)
    const normalPercentage = Math.max(0, Math.min(100, (normalScore / currentScores.max) * 100));
    const renderedPercentage = Math.max(0, Math.min(100, (renderedScore / currentScores.max) * 100));

    const textVerdict = getVerdict(normalPercentage);
    const renderedVerdict = getVerdict(renderedPercentage);

    const textProgressBar = document.getElementById('text-progress-bar');
    const renderedProgressBar = document.getElementById('rendered-progress-bar');
    const textScoreText = document.getElementById('text-score-text');
    const renderedScoreText = document.getElementById('rendered-score-text');

    if (textProgressBar && textScoreText) {
        textProgressBar.style.width = `${normalPercentage}%`;
        textProgressBar.style.backgroundColor = textVerdict.color;
        textScoreText.textContent = `${textVerdict.text} (${normalPercentage.toFixed(0)}%)`;
        textScoreText.style.color = textVerdict.color;
        textScoreText.classList.remove('score-text-disabled');
    }

    if (renderedProgressBar && renderedScoreText) {
        renderedProgressBar.style.width = `${renderedPercentage}%`;
        renderedProgressBar.style.backgroundColor = renderedVerdict.color;
        renderedScoreText.textContent = `${renderedVerdict.text} (${renderedPercentage.toFixed(0)}%)`;
        renderedScoreText.style.color = renderedVerdict.color;
        renderedScoreText.classList.remove('score-text-disabled');
    }
}

function updateDomainUI(data) {
    const cell = document.getElementById('cell-domain');
    if (cell) {
        cell.innerHTML = `<div>
            <p>${data.message} ${createScoreBadge(data.scoreImpact)}</p> 
            <p>They are sending from an email with the domain <b>${data.suspectSubdomain}</b></p>
        </div>`;
    }
}

function updateUrlUI(data) {
    const summaryEl = document.getElementById('url-scan-summary');
    if (summaryEl) {
        // Check for the "Disabled" status sent from the backend
        if (data.status === "Disabled") {
            summaryEl.innerHTML = `<div><p><strong>Scan Disabled:</strong> ${data.message}</p></div>`;
        } else {

            summaryEl.innerHTML = `<div>
                <p><strong>Scan Complete:</strong> ${data.message} ${createScoreBadge(data.scoreImpact)}</p>
            </div>`;
        }
    }
}
function updateAttachmentsUI(data) {
    const cell = document.getElementById('cell-attachments');
    if (cell) {
        cell.innerHTML = `<div><p>${data.message} ${createScoreBadge(data.scoreImpact)}</p></div>`;
    }
}

function updateContentAnalysisUI(type, data) {
    const renderPhoneNumbers = (contactAnalysis) => {
        if (!contactAnalysis || !contactAnalysis.phoneNumbers || contactAnalysis.phoneNumbers.length === 0) {
            return `<p>No phone numbers found. ${createScoreBadge(contactAnalysis.scoreImpact)}</p>`;
        }
        let html = '<ul class="phone-list">';
        contactAnalysis.phoneNumbers.forEach(phone => {
            const icon = phone.isValid ? '✅' : '❌';
            html += `<li>${icon} ${phone.phoneNumber}</li>`;
        });
        html += '</ul>' + createScoreBadge(contactAnalysis.scoreImpact);
        return html;
    };

    const updateElement = (id, html) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
    };

    updateElement(`cell-${type}-phone`, `<div>${renderPhoneNumbers(data.contactMethodAnalysis)}</div>`);
    updateElement(`cell-${type}-company`, `<div><p>${data.companyIdentification.identified ? data.companyIdentification.name : 'Not Identified'} ${createScoreBadge(data.companyIdentification.scoreImpact)}</p></div>`);
    updateElement(`cell-${type}-verification`, `<div><p>${data.companyVerification.message} ${createScoreBadge(data.companyVerification.scoreImpact)}</p></div>`);
    updateElement(`cell-${type}-realism`, `<div><p>${data.realismAnalysis.reason} ${createScoreBadge(data.realismAnalysis.scoreImpact)}</p></div>`);
    updateElement(`cell-${type}-summary`, `<div><p>${data.summary}</p></div>`);
    updateElement(`cell-${type}-action`, `<div><p>${data.actionAnalysis.actionRequired ? data.actionAnalysis.action : 'No action required.'}</p></div>`);
}

function createScoreBadge(score) {
    // Check if the score is undefined or null (simulating a loading state if passed into this function)
    if (score === undefined || score === null) {
        // Use a small spinner for the badge loading state
        return `<span class="score-badge score-loading"><div class="spinner-small"></div></span>`;
    }

    const sign = score <= 0 ? '❌' : '+';
    const className = score <= 0 ? 'score-negative' : 'score-positive';
    return `<span class="score-badge ${className}">(${sign}${score})</span>`;
}

function getVerdict(percentage) {
    const p = Math.min(100, percentage);
    if (p < 40) return { text: "High Risk", color: "#d94848" };
    if (p < 70) return { text: "Suspicious", color: "#f5a623" };
    return { text: "Looks Safe", color: "#0d8a4f" };
}