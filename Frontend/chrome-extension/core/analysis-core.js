/* global document */

import { createEmptyResults, buildReport } from './report-model.js';
import { bindPanel, renderNoticePanel, renderReportPanel } from './verdict-panel.js';
import { getCachedAnalysis, saveCachedAnalysis, hashString } from './cache-manager.js';

const DEFAULT_CHECKS = {
    checkDomain: true,
    checkUrls: true,
    checkAttachments: true,
    checkTextAnalysis: true,
    checkRenderedAnalysis: true,
};

// Results of the analysis on screen. No verdict is shown until every check has
// landed (finalScores), so stream events only accumulate here until then.
let results = createEmptyResults(DEFAULT_CHECKS);
let activeSessionId = null;
let activeContainerId = null;
let activeCacheKey = null;

function newSessionId() {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function mergeChecks(settings = {}) {
    return { ...DEFAULT_CHECKS, ...(settings?.checks || settings) };
}

export async function streamAnalysis(emlData, settings, options = {}) {
    const { signal, sessionId, forceRerun, emailKey } = options;
    const cacheKey = emailKey || (emlData ? `eml_${hashString(emlData)}` : null);
    activeCacheKey = cacheKey;

    // 1. Check local cache before contacting backend if not forcing a rerun
    if (!forceRerun && cacheKey) {
        const cached = await getCachedAnalysis(cacheKey);
        if (cached && cached.results && cached.results.final) {
            console.log("EmailChecker: Restoring from local cache, no backend contact needed.");
            results = cached.results;
            showVerdict();
            return;
        }
    }

    const enabledChecks = mergeChecks(settings);
    const streamSessionId = sessionId || activeSessionId || newSessionId();
    if (streamSessionId !== activeSessionId) {
        activeSessionId = streamSessionId;
        results = createEmptyResults(enabledChecks);
    }

    const url = new URL("http://127.0.0.1:8080/process-eml-stream");

    if (settings) {
        Object.entries(enabledChecks).forEach(([key, value]) => {
            url.searchParams.append(key, value ? "true" : "false");
        });
    }

    if (forceRerun) {
        url.searchParams.append("rerun", "true");
        url.searchParams.append("forceRerun", "true");
    }

    const headers = {
        "Content-Type": "text/plain;charset=UTF-8",
    };
    if (forceRerun) {
        headers["X-Force-Rerun"] = "true";
        headers["Cache-Control"] = "no-cache";
    }

    let response;
    try {
        response = await fetch(url.href, {
            method: "POST",
            headers,
            body: emlData,
            signal,
        });
    } catch (error) {
        if (error.name === "AbortError") {
            throw error;
        }
        throw new Error("Unable to reach backend service");
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
            processSSEMessage(part, streamSessionId);
        }
    }
    if (buffer.trim()) {
        processSSEMessage(buffer, streamSessionId);
    }

    if (streamSessionId === activeSessionId && !results.final) {
        throw new Error("The analysis stopped before every check finished.");
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
        let payload;
        try {
            payload = JSON.parse(dataJson);
        } catch (error) {
            console.error("Failed to parse SSE data:", dataJson, error);
            return;
        }
        handleStreamEvent(eventName, payload, sessionId);
    }
}

// A rendered analysis whose OCR read no text comes back zero-valued rather than as an error.
function normalizeContentResult(payload) {
    const empty = payload && !payload.error && !payload.summary
        && !payload.realismAnalysis?.reason && !payload.companyIdentification?.identified;
    return empty ? { ...payload, error: "No readable text in the email." } : payload;
}

let completedKeys = new Set();

function updateLiveUI() {
    if (!activeContainerId) return;
    const container = document.getElementById(activeContainerId);
    if (!container) return;

    const report = buildReport(results);
    const newlyCompleted = new Set();
    for (const c of report.checks || []) {
        if (!c.isPending && !completedKeys.has(c.key)) {
            newlyCompleted.add(c.key);
            completedKeys.add(c.key);
        }
    }
    report.newlyCompletedKeys = newlyCompleted;

    container.innerHTML = renderReportPanel(report);
    container.style.display = "block";
}

const eventHandlers = {
    'maxScore': (payload) => {
        results.maxScore = payload.maxScore;
        if (payload.enabledChecks) results.enabled = { ...results.enabled, ...payload.enabledChecks };
        updateLiveUI();
    },
    'domainAnalysis': (payload) => {
        results.domain = payload;
        updateLiveUI();
    },
    'urlScanStarted': (payload) => {
        results.urlTotal = payload.total;
        updateLiveUI();
    },
    'urlScanResult': (payload) => {
        results.urlResults.push(payload);
        updateLiveUI();
    },
    'urlAnalysis': (payload) => {
        results.urlAnalysis = payload;
        updateLiveUI();
    },
    'executableAnalysis': (payload) => {
        results.attachments = payload;
        updateLiveUI();
    },
    'textAnalysis': (payload) => {
        if (payload.error) console.error("Text analysis failed:", payload.error);
        results.text = normalizeContentResult(payload);
        updateLiveUI();
    },
    'renderedAnalysis': (payload) => {
        if (payload.error) console.error("Rendered analysis failed:", payload.error);
        results.rendered = normalizeContentResult(payload);
        updateLiveUI();
    },
    'finalScores': (payload) => {
        console.log("Final scores received from backend:", payload);
        results.final = payload;
        showVerdict();
    }
};

function handleStreamEvent(eventName, payload, sessionId) {
    if (sessionId !== activeSessionId) {
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
    activeSessionId = sessionId || newSessionId();
    activeContainerId = containerId;
    completedKeys = new Set();
    results = createEmptyResults(mergeChecks(settings));
    const container = document.getElementById(containerId);
    if (!container) return;
    bindPanel(container);
    container.style.display = "block";
    updateLiveUI();
}

function showVerdict() {
    const report = buildReport(results);
    const newlyCompleted = new Set();
    for (const c of report.checks || []) {
        if (!c.isPending && !completedKeys.has(c.key)) {
            newlyCompleted.add(c.key);
            completedKeys.add(c.key);
        }
    }
    report.newlyCompletedKeys = newlyCompleted;

    const container = activeContainerId ? document.getElementById(activeContainerId) : null;
    const html = report.verdict
        ? renderReportPanel(report)
        : renderNoticePanel({
            title: "No checks are turned on",
            sub: "Turn on at least one check in the options to get a verdict for this email.",
        });

    if (container) {
        container.innerHTML = html;
        container.style.display = "block";
    }

    if (activeCacheKey && report.verdict) {
        saveCachedAnalysis(activeCacheKey, {
            results,
            report,
            summary: {
                verdict: report.verdict,
                pct: report.pct,
                badge: report.badge || null,
                interstitial: report.interstitial || null,
            },
            html,
        });
    }

    document.dispatchEvent(new CustomEvent('analysisComplete', {
        detail: {
            sessionId: activeSessionId,
            verdict: report.verdict,
            pct: report.pct,
            badge: report.badge || null,
            interstitial: report.interstitial || null,
            report,
            results,
            html,
        }
    }));
}

export function showAnalysisError(containerId, message, sessionId) {
    if (sessionId && activeSessionId && sessionId !== activeSessionId) return;
    const container = document.getElementById(containerId);
    if (container) {
        let clean = (message || "")
            .replace(/:\s*Failed to fetch/gi, "")
            .replace(/:\s*NetworkError.*/gi, "")
            .replace(/^Error:\s*/i, "")
            .trim();
        if (!clean || /failed to fetch/i.test(clean)) {
            clean = "Unable to reach backend service";
        }
        container.innerHTML = renderNoticePanel({
            title: "We couldn't check this email",
            sub: clean,
        });
        container.style.display = "block";
    }
    document.dispatchEvent(new CustomEvent('analysisFailed', {
        detail: { sessionId: sessionId || activeSessionId, message }
    }));
}
