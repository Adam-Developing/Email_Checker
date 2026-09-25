// Renders the simplistic, clear verdict panel
// (Hero verdict card, unified check results list, optional links)
// from a report built by report-model.js.

import { formatPoints } from './report-model.js';

export function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

export function renderReportPanel(report) {
    const isChecking = !!report.isChecking;
    const t = report.theme || {
        color: "#0d8a4f",
        ink: "#002B4D",
        heroBg: "#f8fafc",
        badge: { bg: "#f1f5f9", border: "#cbd5e1" },
    };

    // Action banner for suspicious or high risk (only when checks are complete)
    const actionBanner = (!isChecking && report.actionTip) ? `
        <div class="ec-action-banner ec-action-${report.verdict}">
            <span class="ec-action-icon">${report.verdict === "highrisk" ? "🚨" : "⚠️"}</span>
            <span class="ec-action-text">${escapeHtml(report.actionTip)}</span>
        </div>` : "";

    // Hero verdict tag: animated spinner tag while checking, or verdict badge when complete
    const verdictTagHtml = isChecking ? `
        <div class="ec-verdict-tag is-checking">
            <span class="ec-spinner-lg"></span>
            <span class="ec-verdict-title">${escapeHtml(report.title || "Analyzing email…")}</span>
        </div>` : `
        <div class="ec-verdict-tag" style="background: ${t.badge.bg}; border-color: ${t.badge.border}; color: ${t.ink};">
            <span class="ec-verdict-glyph" style="background: ${t.color};">${escapeHtml(t.glyph)}</span>
            <span class="ec-verdict-title">${escapeHtml(report.title)}</span>
        </div>`;

    // Meter track: progress fill with pulse shimmer while checking
    const meterHtml = `
        <div class="ec-meter-track">
            <div class="ec-meter-fill" style="width: ${Math.max(6, Math.min(100, report.pct || 0))}%; background: ${t.color};"></div>
            ${isChecking ? '<div class="ec-meter-pulse"></div>' : ''}
        </div>`;

    // Hero section
    const heroHtml = `
        <div class="ec-hero ${isChecking ? 'is-checking' : ''}" style="background: ${t.heroBg};">
            <div class="ec-hero-header">
                ${verdictTagHtml}
                <div class="ec-score-badge" style="color: ${t.ink};">
                    <span class="ec-score-pct ${isChecking ? 'ec-score-live' : ''}">${report.pct !== null ? report.pct + '%' : '--%'}</span>
                    <span class="ec-score-pts">${formatPoints(report.earned)} / ${report.max} pts</span>
                </div>
            </div>

            <p class="ec-hero-sub">${escapeHtml(report.sub)}</p>

            ${meterHtml}

            ${actionBanner}
        </div>`;

    // Unified combined check results list in the requested order:
    // Organization Identified, No Domain Spoofing, Verified Phone Number, Safe Links, Safe Attachments, Sender Address Verified, Legitimate Tone & Content
    const checkRows = (report.checks || []).map((c) => {
        if (c.isPending) {
            return `
                <div class="ec-point-row is-pending" data-key="${escapeHtml(c.key)}">
                    <span class="ec-point-pill is-pending">
                        <span class="ec-spinner-sm"></span> Checking…
                    </span>
                    <div class="ec-point-info">
                        <div class="ec-point-name">${escapeHtml(c.title)}</div>
                        <div class="ec-point-desc">${escapeHtml(c.reason)}</div>
                    </div>
                </div>`;
        }

        const isJustCompleted = report.newlyCompletedKeys && report.newlyCompletedKeys.has(c.key);
        const animClass = isJustCompleted ? "ec-just-completed" : "";
        const rowClass = c.isGained ? "is-gained" : "is-lost";
        const pillText = c.isGained ? `+${formatPoints(c.points)} pts` : `-${formatPoints(c.lost)} pts`;
        return `
            <div class="ec-point-row ${rowClass} ${animClass}" data-key="${escapeHtml(c.key)}">
                <span class="ec-point-pill ${rowClass} ${animClass}">${pillText}</span>
                <div class="ec-point-info">
                    <div class="ec-point-name">${escapeHtml(c.title)}</div>
                    <div class="ec-point-desc">${escapeHtml(c.reason)}</div>
                </div>
            </div>`;
    }).join("");

    const checksHtml = `
        <div class="ec-breakdown-group">
            <div class="ec-group-header">
                <span class="ec-group-title">Check Results</span>
                <span class="ec-group-badge is-gained">${formatPoints(report.earned)} / ${report.max} pts</span>
            </div>
            <div class="ec-point-list">
                ${checkRows}
            </div>
        </div>`;

    // Optional Scanned URLs list (collapsed by default to prevent clutter)
    let urlsHtml = "";
    if (report.urlsOn && report.urls && report.urls.length > 0) {
        const items = report.urls.map((u) => {
            const isMal = u.kind === "malicious";
            const isSkipped = u.kind === "skipped";
            const tagClass = isMal ? "is-malicious" : isSkipped ? "is-skipped" : "is-clean";
            const tagLabel = isMal ? "Flagged" : isSkipped ? "Skipped" : "Clean";
            const note = u.reason ? `<span class="ec-url-note">(${escapeHtml(u.reason)})</span>` : "";
            const link = u.report
                ? `<a class="ec-url-link" href="${escapeHtml(u.report)}" target="_blank" rel="noopener noreferrer">${escapeHtml(u.url)}</a>`
                : `<span class="ec-url-link">${escapeHtml(u.url)}</span>`;
            return `
                <li class="ec-url-item ${tagClass}">
                    <span class="ec-url-status ${tagClass}">${tagLabel}</span>
                    ${link}
                    ${note}
                </li>`;
        }).join("");

        const hasSkipped = report.urls.some((u) => u.kind === "skipped");
        const listLabel = hasSkipped ? `Links (${report.urls.length})` : `Scanned links (${report.urls.length})`;

        urlsHtml = `
            <div class="ec-urls-container">
                <button type="button" class="ec-urls-toggle" data-ec-action="toggle-links" aria-expanded="false">
                    <span>${listLabel}</span>
                    <span class="ec-toggle-chevron">▼ Show</span>
                </button>
                <div class="ec-urls-dropdown" hidden>
                    <ul class="ec-url-list">${items}</ul>
                </div>
            </div>`;
    }

    return `
        <div class="ec-panel">
            ${heroHtml}
            <div class="ec-breakdown-content">
                ${checksHtml}
                ${urlsHtml}
            </div>
        </div>`;
}

export function renderCheckingPanel() {
    return `
        <div class="ec-panel">
            <div class="ec-hero is-checking">
                <div class="ec-hero-header">
                    <div class="ec-verdict-tag is-checking">
                        <span class="ec-spinner-lg"></span>
                        <span class="ec-verdict-title">Analyzing email…</span>
                    </div>
                </div>
                <p class="ec-hero-sub">Checking sender domain, links, attachments, and content realism.</p>
                <div class="ec-meter-track">
                    <div class="ec-meter-pulse"></div>
                </div>
            </div>
            <div class="ec-checking-note">Results will appear here once checks finish.</div>
        </div>`;
}

export function renderNoticePanel({ title, sub }) {
    return `
        <div class="ec-panel">
            <div class="ec-hero is-notice">
                <div class="ec-notice-header">
                    <div class="ec-notice-title">${escapeHtml(title)}</div>
                </div>
                <p class="ec-hero-sub">${escapeHtml(sub)}</p>
            </div>
        </div>`;
}

export function bindPanel(container) {
    if (!container || container.dataset.ecBound) return;
    container.dataset.ecBound = "true";
    container.addEventListener("click", (event) => {
        const rerun = event.target.closest('[data-ec-action="rerun"]');
        if (rerun && container.contains(rerun)) {
            event.preventDefault();
            event.stopPropagation();
            document.dispatchEvent(new CustomEvent('requestRerun', {
                bubbles: true,
                detail: { containerId: container.id }
            }));
            return;
        }

        const toggle = event.target.closest('[data-ec-action="toggle-links"]');
        if (!toggle || !container.contains(toggle)) return;
        const dropdown = toggle.parentElement.querySelector(".ec-urls-dropdown");
        if (!dropdown) return;
        dropdown.hidden = !dropdown.hidden;
        toggle.setAttribute("aria-expanded", String(!dropdown.hidden));
        const chevron = toggle.querySelector(".ec-toggle-chevron");
        if (chevron) chevron.textContent = dropdown.hidden ? "▼ Show" : "▲ Hide";
    });
}
