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

let userLinksExpanded = null;

export function resetPanelState() {
    userLinksExpanded = null;
}

export function renderCheckRowsHtml(report) {
    return (report.checks || []).map((c) => {
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
        let rowClass = "is-lost";
        let pillText = `-${formatPoints(c.lost)} pts`;
        
        if (c.couldNotRun) {
            rowClass = "is-untested";
            pillText = "Not run";
        } else if (c.isWarning) {
            if (c.lost === 0) {
                rowClass = "is-untested";
                pillText = "Skipped";
            } else {
                rowClass = "is-warning";
                pillText = `-${formatPoints(c.lost)} pts`;
            }
        } else if (c.isGained) {
            rowClass = "is-gained";
            pillText = `+${formatPoints(c.points)} pts`;
        } else if (c.lost === 0) {
            pillText = "0 pts";
        }
        return `
            <div class="ec-point-row ${rowClass} ${animClass}" data-key="${escapeHtml(c.key)}">
                <span class="ec-point-pill ${rowClass} ${animClass}">${pillText}</span>
                <div class="ec-point-info">
                    <div class="ec-point-name">${escapeHtml(c.title)}</div>
                    <div class="ec-point-desc">${escapeHtml(c.reason)}</div>
                </div>
            </div>`;
    }).join("");
}

export function renderUrlsHtml(report) {
    if (!report.urlsOn || !report.urls || report.urls.length === 0) return "";
    const items = report.urls.map((u) => {
        const isPending = u.kind === "pending";
        const isMal = u.kind === "malicious";
        const isSkipped = u.kind === "skipped";
        const isError = u.kind === "error";
        const tagClass = isPending ? "is-pending" : isMal ? "is-malicious" : isSkipped ? "is-skipped" : isError ? "is-skipped" : "is-clean";
        const tagLabel = isPending ? '<span class="ec-spinner-sm"></span> Checking…' : isMal ? "Flagged" : isSkipped ? "Skipped" : isError ? "Error" : "Clean";
        const reasonText = u.reason || u.error;
        const note = reasonText ? `<span class="ec-url-note">(${escapeHtml(reasonText)})</span>` : "";
        const link = u.report
            ? `<a class="ec-url-link" href="${escapeHtml(u.report)}" target="_blank" rel="noopener noreferrer">${escapeHtml(u.url)}</a>`
            : `<span class="ec-url-link">${escapeHtml(u.url)}</span>`;
        return `
            <li class="ec-url-item ${tagClass}" data-url="${escapeHtml(u.url)}">
                <span class="ec-url-status ${tagClass}">${tagLabel}</span>
                ${link}
                ${note}
            </li>`;
    }).join("");

    const hasSkipped = report.urls.some((u) => u.kind === "skipped");
    const hasPending = report.urls.some((u) => u.kind === "pending");
    const listLabel = hasPending
        ? `Checking links (${report.urls.filter((u) => u.kind !== "pending").length}/${report.urls.length})`
        : hasSkipped
            ? `Links (${report.urls.length})`
            : `Scanned links (${report.urls.length})`;

    const isExpanded = userLinksExpanded !== null ? userLinksExpanded : false;

    return `
        <div class="ec-urls-container">
            <button type="button" class="ec-urls-toggle" data-ec-action="toggle-links" aria-expanded="${isExpanded}">
                <span>${listLabel}</span>
                <span class="ec-toggle-chevron">${isExpanded ? "▲ Hide" : "▼ Show"}</span>
            </button>
            <div class="ec-urls-dropdown"${isExpanded ? "" : " hidden"}>
                <ul class="ec-url-list">${items}</ul>
            </div>
        </div>`;
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

    const checkRows = renderCheckRowsHtml(report);

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

    const urlsHtml = renderUrlsHtml(report);

    return `
        <div class="ec-panel">
            ${heroHtml}
            <div class="ec-breakdown-content">
                ${checksHtml}
                ${urlsHtml}
            </div>
        </div>`;
}

export function updateReportPanel(container, report) {
    if (!container) return;
    const panel = container.querySelector('.ec-panel');
    if (!panel) {
        container.innerHTML = renderReportPanel(report);
        bindPanel(container);
        return;
    }

    const isChecking = !!report.isChecking;
    const t = report.theme || {
        color: "#0d8a4f",
        ink: "#002B4D",
        heroBg: "#f8fafc",
        badge: { bg: "#f1f5f9", border: "#cbd5e1" },
    };

    // 1. Hero background & class
    const hero = panel.querySelector('.ec-hero');
    if (hero) {
        hero.style.background = t.heroBg;
        if (isChecking) {
            hero.classList.add('is-checking');
        } else {
            hero.classList.remove('is-checking');
        }

        // Hero verdict tag
        const verdictTag = hero.querySelector('.ec-verdict-tag');
        if (verdictTag) {
            if (isChecking) {
                verdictTag.className = 'ec-verdict-tag is-checking';
                verdictTag.style.background = '';
                verdictTag.style.borderColor = '';
                verdictTag.style.color = '';

                // Remove glyph if present
                const glyph = verdictTag.querySelector('.ec-verdict-glyph');
                if (glyph) glyph.remove();

                // Ensure spinner
                let spinner = verdictTag.querySelector('.ec-spinner-lg');
                if (!spinner) {
                    spinner = document.createElement('span');
                    spinner.className = 'ec-spinner-lg';
                    verdictTag.prepend(spinner);
                }

                let title = verdictTag.querySelector('.ec-verdict-title');
                if (!title) {
                    title = document.createElement('span');
                    title.className = 'ec-verdict-title';
                    verdictTag.appendChild(title);
                }
                title.textContent = report.title || "Analyzing email…";
            } else {
                verdictTag.className = 'ec-verdict-tag';
                verdictTag.style.background = t.badge.bg;
                verdictTag.style.borderColor = t.badge.border;
                verdictTag.style.color = t.ink;

                // Remove spinner
                const spinner = verdictTag.querySelector('.ec-spinner-lg');
                if (spinner) spinner.remove();

                // Ensure glyph
                let glyph = verdictTag.querySelector('.ec-verdict-glyph');
                if (!glyph) {
                    glyph = document.createElement('span');
                    glyph.className = 'ec-verdict-glyph';
                    verdictTag.prepend(glyph);
                }
                glyph.style.background = t.color;
                glyph.textContent = t.glyph || "";

                let title = verdictTag.querySelector('.ec-verdict-title');
                if (!title) {
                    title = document.createElement('span');
                    title.className = 'ec-verdict-title';
                    verdictTag.appendChild(title);
                }
                title.textContent = report.title || "";
            }
        }

        // Score badge
        const badge = hero.querySelector('.ec-score-badge');
        if (badge) badge.style.color = t.ink;
        const pctEl = hero.querySelector('.ec-score-pct');
        if (pctEl) {
            pctEl.textContent = report.pct !== null ? report.pct + '%' : '--%';
            if (isChecking) {
                pctEl.classList.add('ec-score-live');
            } else {
                pctEl.classList.remove('ec-score-live');
            }
        }
        const ptsEl = hero.querySelector('.ec-score-pts');
        if (ptsEl) ptsEl.textContent = `${formatPoints(report.earned)} / ${report.max} pts`;

        // Hero subtitle
        const subEl = hero.querySelector('.ec-hero-sub');
        if (subEl) subEl.textContent = report.sub || "";

        // Meter fill & pulse
        const fillEl = hero.querySelector('.ec-meter-fill');
        if (fillEl) {
            fillEl.style.width = `${Math.max(6, Math.min(100, report.pct || 0))}%`;
            fillEl.style.background = t.color;
        }
        const meterTrack = hero.querySelector('.ec-meter-track');
        if (meterTrack) {
            let pulse = meterTrack.querySelector('.ec-meter-pulse');
            if (isChecking && !pulse) {
                pulse = document.createElement('div');
                pulse.className = 'ec-meter-pulse';
                meterTrack.appendChild(pulse);
            } else if (!isChecking && pulse) {
                pulse.remove();
            }
        }

        // Action banner
        let actionBanner = hero.querySelector('.ec-action-banner');
        if (!isChecking && report.actionTip) {
            if (!actionBanner) {
                actionBanner = document.createElement('div');
                hero.appendChild(actionBanner);
            }
            actionBanner.className = `ec-action-banner ec-action-${report.verdict}`;
            actionBanner.innerHTML = `
                <span class="ec-action-icon">${report.verdict === "highrisk" ? "🚨" : "⚠️"}</span>
                <span class="ec-action-text">${escapeHtml(report.actionTip)}</span>
            `;
        } else if (actionBanner) {
            actionBanner.remove();
        }
    }

    // 2. Breakdown group header badge
    const groupBadge = panel.querySelector('.ec-breakdown-group .ec-group-badge');
    if (groupBadge) groupBadge.textContent = `${formatPoints(report.earned)} / ${report.max} pts`;

    // 3. Point Rows
    const pointList = panel.querySelector('.ec-point-list');
    if (pointList && report.checks) {
        const existingRows = Array.from(pointList.querySelectorAll('.ec-point-row'));
        const existingKeys = existingRows.map((r) => r.dataset.key);
        const newKeys = report.checks.map((c) => c.key);

        const keysMatch = existingKeys.length === newKeys.length && existingKeys.every((k, i) => k === newKeys[i]);
        if (!keysMatch) {
            // Re-render check rows if the key set changed (e.g. domain check split into two rows)
            pointList.innerHTML = renderCheckRowsHtml(report);
        } else {
            // In-place updates for identical keys (prevents restarting CSS animations/spinners)
            report.checks.forEach((c, index) => {
                const row = existingRows[index];
                if (!row) return;

                if (c.isPending) {
                    if (!row.classList.contains('is-pending')) {
                        row.className = 'ec-point-row is-pending';
                        row.dataset.key = c.key;
                        row.innerHTML = `
                            <span class="ec-point-pill is-pending">
                                <span class="ec-spinner-sm"></span> Checking…
                            </span>
                            <div class="ec-point-info">
                                <div class="ec-point-name">${escapeHtml(c.title)}</div>
                                <div class="ec-point-desc">${escapeHtml(c.reason)}</div>
                            </div>`;
                        return;
                    }
                    // Already pending: preserve spinner and update text smoothly
                    const nameEl = row.querySelector('.ec-point-name');
                    if (nameEl && nameEl.textContent !== c.title) nameEl.textContent = c.title;
                    const descEl = row.querySelector('.ec-point-desc');
                    if (descEl && descEl.textContent !== c.reason) descEl.textContent = c.reason;
                } else {
                    const isJustCompleted = report.newlyCompletedKeys && report.newlyCompletedKeys.has(c.key);
                    const animClass = isJustCompleted ? " ec-just-completed" : "";
                    const stateClass = c.couldNotRun ? "is-untested" : (c.isGained ? "is-gained" : "is-lost");
                    const targetRowClass = `ec-point-row ${stateClass}${animClass}`;
                    if (row.className !== targetRowClass) {
                        row.className = targetRowClass;
                    }

                    const pill = row.querySelector('.ec-point-pill');
                    const pillText = c.couldNotRun
                        ? "Not run"
                        : (c.isGained ? `+${formatPoints(c.points)} pts` : `-${formatPoints(c.lost)} pts`);
                    const targetPillClass = `ec-point-pill ${stateClass}${animClass}`;
                    if (pill) {
                        if (pill.className !== targetPillClass) pill.className = targetPillClass;
                        if (pill.textContent !== pillText) pill.textContent = pillText;
                    }

                    const nameEl = row.querySelector('.ec-point-name');
                    if (nameEl && nameEl.textContent !== c.title) nameEl.textContent = c.title;
                    const descEl = row.querySelector('.ec-point-desc');
                    if (descEl && descEl.textContent !== c.reason) descEl.textContent = c.reason;
                }
            });
        }
    }

    // 4. Scanned URLs container
    const breakdownContent = panel.querySelector('.ec-breakdown-content');
    let urlsContainer = panel.querySelector('.ec-urls-container');
    const shouldShowUrls = report.urlsOn && report.urls && report.urls.length > 0;

    if (!shouldShowUrls) {
        if (urlsContainer) urlsContainer.remove();
    } else {
        if (!urlsContainer && breakdownContent) {
            const div = document.createElement('div');
            div.innerHTML = renderUrlsHtml(report);
            if (div.firstElementChild) {
                breakdownContent.appendChild(div.firstElementChild);
            }
        } else if (urlsContainer) {
            // Update toggle button text
            const hasSkipped = report.urls.some((u) => u.kind === "skipped");
            const hasPending = report.urls.some((u) => u.kind === "pending");
            const listLabel = hasPending
                ? `Checking links (${report.urls.filter((u) => u.kind !== "pending").length}/${report.urls.length})`
                : hasSkipped
                    ? `Links (${report.urls.length})`
                    : `Scanned links (${report.urls.length})`;

            const toggleBtn = urlsContainer.querySelector('.ec-urls-toggle');
            if (toggleBtn) {
                const labelSpan = toggleBtn.querySelector('span:first-child');
                if (labelSpan && labelSpan.textContent !== listLabel) {
                    labelSpan.textContent = listLabel;
                }
            }

            // In-place updates for URLs in ec-url-list
            const urlList = urlsContainer.querySelector('.ec-url-list');
            if (urlList) {
                const existingItems = Array.from(urlList.querySelectorAll('.ec-url-item'));
                const existingMap = new Map();
                existingItems.forEach((li) => existingMap.set(li.dataset.url, li));

                report.urls.forEach((u) => {
                    const isPending = u.kind === "pending";
                    const isMal = u.kind === "malicious";
                    const isSkipped = u.kind === "skipped";
                    const isError = u.kind === "error";
                    const tagClass = isPending ? "is-pending" : isMal ? "is-malicious" : isSkipped ? "is-skipped" : isError ? "is-skipped" : "is-clean";
                    const tagLabel = isPending ? '<span class="ec-spinner-sm"></span> Checking…' : isMal ? "Flagged" : isSkipped ? "Skipped" : isError ? "Error" : "Clean";
                    const reasonText = u.reason || u.error;
                    const note = reasonText ? `(${reasonText})` : "";

                    const existingLi = existingMap.get(u.url);
                    if (existingLi) {
                        const targetItemClass = `ec-url-item ${tagClass}`;
                        if (existingLi.className !== targetItemClass) existingLi.className = targetItemClass;

                        const statusSpan = existingLi.querySelector('.ec-url-status');
                        if (statusSpan) {
                            const targetStatusClass = `ec-url-status ${tagClass}`;
                            if (statusSpan.className !== targetStatusClass) statusSpan.className = targetStatusClass;
                            if (statusSpan.innerHTML !== tagLabel) statusSpan.innerHTML = tagLabel;
                        }

                        let noteSpan = existingLi.querySelector('.ec-url-note');
                        if (note) {
                            if (!noteSpan) {
                                noteSpan = document.createElement('span');
                                noteSpan.className = 'ec-url-note';
                                existingLi.appendChild(noteSpan);
                            }
                            if (noteSpan.textContent !== note) noteSpan.textContent = note;
                        } else if (noteSpan) {
                            noteSpan.remove();
                        }

                        const existingLink = existingLi.querySelector('.ec-url-link');
                        if (u.report && existingLink?.tagName !== 'A') {
                            const a = document.createElement('a');
                            a.className = 'ec-url-link';
                            a.href = u.report;
                            a.target = '_blank';
                            a.rel = 'noopener noreferrer';
                            a.textContent = u.url;
                            existingLink.replaceWith(a);
                        } else if (u.report && existingLink?.tagName === 'A') {
                            if (existingLink.href !== u.report) existingLink.href = u.report;
                        }
                    } else {
                        // Append new item if not present
                        const li = document.createElement('li');
                        li.className = `ec-url-item ${tagClass}`;
                        li.dataset.url = u.url;
                        const linkHtml = u.report
                            ? `<a class="ec-url-link" href="${escapeHtml(u.report)}" target="_blank" rel="noopener noreferrer">${escapeHtml(u.url)}</a>`
                            : `<span class="ec-url-link">${escapeHtml(u.url)}</span>`;
                        const noteHtml = u.reason ? `<span class="ec-url-note">(${escapeHtml(u.reason)})</span>` : "";
                        li.innerHTML = `
                            <span class="ec-url-status ${tagClass}">${tagLabel}</span>
                            ${linkHtml}
                            ${noteHtml}
                        `;
                        urlList.appendChild(li);
                    }
                });
            }
        }
    }
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
        const willBeHidden = !dropdown.hidden;
        dropdown.hidden = willBeHidden;
        toggle.setAttribute("aria-expanded", String(!willBeHidden));
        userLinksExpanded = !willBeHidden;
        const chevron = toggle.querySelector(".ec-toggle-chevron");
        if (chevron) chevron.textContent = willBeHidden ? "▼ Show" : "▲ Hide";
    });
}
