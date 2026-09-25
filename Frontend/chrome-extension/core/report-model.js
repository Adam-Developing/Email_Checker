// Plain-language report model for Email Security Analyser.
// Calculates points earned and points lost for each check with concise, clear explanations.

export const COLORS = {
    red: "#d94848",
    amber: "#f5a623",
    green: "#0d8a4f",
    inkRed: "#8f1d1d",
    inkAmber: "#8a5a07",
    inkGreen: "#0a6b3e",
    inkNeutral: "#002B4D",
    grey: "#9aa4af",
};

export const VERDICTS = {
    safe: {
        color: COLORS.green,
        ink: COLORS.inkGreen,
        glyph: "✓",
        heroBg: "#f4fbf7",
        title: "Looks Genuine",
        badge: { label: "Looks Genuine", bg: "#eaf7f0", border: "#bfe4d0" },
    },
    suspicious: {
        color: COLORS.amber,
        ink: COLORS.inkAmber,
        glyph: "!",
        heroBg: "#fffaf0",
        title: "Suspicious",
        badge: { label: "Suspicious", bg: "#fff6e6", border: "#f0d9ab" },
    },
    highrisk: {
        color: COLORS.red,
        ink: COLORS.inkRed,
        glyph: "!",
        heroBg: "#fdf3f3",
        title: "Likely a Scam",
        badge: { label: "Likely a Scam", bg: "#fdeeee", border: "#eec4c4" },
    },
};

// Maximum points per check; mirrors AllChecks in Backend/scoreSettings.go.
const MAX = {
    domain: 30,
    companyIdentified: 3,
    companyVerified: 20,
    realism: 25,
    phone: 4,
    urls: 10,
    attachments: 3,
};

export function createEmptyResults(enabledChecks = {}) {
    return {
        enabled: { ...enabledChecks },
        maxScore: null,
        domain: null,
        urlTotal: null,
        urlResults: [],
        urlAnalysis: null,
        attachments: null,
        text: null,
        rendered: null,
        final: null,
    };
}

export function verdictForPercent(pct) {
    if (pct === null) return null;
    if (pct < 40) return "highrisk";
    if (pct < 70) return "suspicious";
    return "safe";
}

export function formatPoints(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function average(values) {
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function truncate(text, max) {
    const clean = (text || "").replace(/\s+/g, " ").trim();
    if (clean.length <= max) return clean;
    const cut = clean.slice(0, max);
    const lastStop = cut.lastIndexOf(". ");
    return lastStop > max * 0.5 ? cut.slice(0, lastStop + 1) : `${cut.replace(/\s+\S*$/, "")}…`;
}

// Gathers facts from all available backend check outputs.
function gatherFacts(results) {
    const enabled = results.enabled || {};
    const on = (key) => enabled[key] !== false;

    const analyses = [];
    if (on("checkTextAnalysis")) analyses.push({ kind: "text", data: results.text });
    if (on("checkRenderedAnalysis")) analyses.push({ kind: "rendered", data: results.rendered });
    const contentOn = analyses.length > 0;
    const ran = analyses.filter((a) => a.data && !a.data.error);

    const identifiedIn = ran.filter((a) => a.data.companyIdentification?.identified && a.data.companyIdentification.name);
    const company = identifiedIn.length ? identifiedIn[0].data.companyIdentification.name : "";
    const verified = ran.some((a) => a.data.companyVerification?.verified);

    const domain = on("checkDomain") ? results.domain : null;
    const senderDomain = domain?.suspectSubdomain || "";
    const impersonation = domain?.status === "DomainImpersonation";
    const exactMatch = domain?.status === "DomainExactMatch";
    const officialDomain = impersonation ? domain.matchedDomain : (exactMatch && verified ? senderDomain : "");

    const flaggedByReport = new Map();
    for (const v of results.urlAnalysis?.urlVerdicts || []) {
        if (v && v.report) flaggedByReport.set(v.report, v.score);
    }
    const scannedUrls = (results.urlResults || []).map((r) => ({
        url: r.url,
        report: r.report || "",
        kind: r.error ? "error" : (r.finalDecision ? "malicious" : "clean"),
        flagged: flaggedByReport.has(r.report) ? flaggedByReport.get(r.report) : null,
        error: r.error || "",
    }));
    const skippedSensitiveCount = results.urlAnalysis?.skippedSensitiveCount || 0;
    const skippedSensitiveReasons = results.urlAnalysis?.skippedSensitiveReasons || [];
    const skippedReasonSummary = skippedSensitiveReasons.join(", ");
    const skippedUrls = (results.urlAnalysis?.skippedURLs || []).map((s) => ({
        url: s.url,
        report: "",
        kind: "skipped",
        reason: s.category || "sensitive link",
        flagged: null,
        error: "",
    }));
    const urls = [...scannedUrls, ...skippedUrls];
    const urlsOn = on("checkUrls");
    const urlsServerDisabled = results.urlAnalysis?.status === "Disabled";
    const maliciousCount = Math.max(results.urlAnalysis?.maliciousCount || 0, urls.filter((u) => u.kind === "malicious").length);
    const urlErrorCount = urls.filter((u) => u.kind === "error").length;
    const urlCount = Math.max(scannedUrls.length, results.urlTotal || 0);
    const urlMessage = results.urlAnalysis?.message || "";

    const attachmentsOn = on("checkAttachments");
    const attachmentFound = attachmentsOn && !!results.attachments?.found;
    const attachmentName = attachmentFound
        ? (results.attachments.message || "").replace(/^Found dangerous attachment:\s*/i, "").trim() || "executable file"
        : "";

    const realismKnown = ran.filter((a) => a.data.realismAnalysis);
    const unrealistic = realismKnown.filter((a) => !a.data.realismAnalysis.isRealistic);
    const realismReason = (unrealistic[0] || realismKnown[0])?.data.realismAnalysis.reason || "";

    const phones = new Map();
    for (const a of ran) {
        for (const p of a.data.contactMethodAnalysis?.phoneNumbers || []) {
            if (!p?.phoneNumber) continue;
            phones.set(p.phoneNumber, (phones.get(p.phoneNumber) || false) || !!p.isValid);
        }
    }
    const invalidPhones = [...phones].filter(([, valid]) => !valid).map(([n]) => n);
    const validPhones = [...phones].filter(([, valid]) => valid).map(([n]) => n);

    const failed = [];
    if (domain?.status === "Error") failed.push("Sender domain check");
    for (const a of analyses) {
        if (a.data?.error) failed.push(a.kind === "text" ? "Text analysis" : "Rendered image analysis");
    }

    const isChecking = !results.final;
    const domainArrived = !!results.domain;
    const urlsArrived = !!results.urlAnalysis;
    const attachmentsArrived = !!results.attachments;
    const contentArrived = ran.length > 0;

    return {
        results, on, analyses, contentOn, ran, identifiedIn, company, verified,
        domain, senderDomain, impersonation, exactMatch, officialDomain,
        urls, urlsOn, urlsServerDisabled, maliciousCount, urlErrorCount, urlCount,
        skippedSensitiveCount, skippedSensitiveReasons, skippedReasonSummary, urlMessage,
        attachmentsOn, attachmentFound, attachmentName,
        realismKnown, unrealistic, realismReason,
        phones, invalidPhones, validPhones, failed,
        isChecking, domainArrived, urlsArrived, attachmentsArrived, contentArrived,
    };
}

// Builds individual check items in the exact requested order:
// 1. Organization Identified
// 2. No Domain Spoofing
// 3. Verified Phone Number
// 4. Safe Links
// 5. Safe Attachments
// 6. Sender Address Verified
// 7. Legitimate Tone & Content
function buildChecks(f) {
    const r = f.results;
    const checks = [];
    const contentPoints = (pick) => (f.ran.length ? average(f.ran.map((a) => pick(a.data) || 0)) : 0);
    const off = f.ran.length === 0;
    const company = f.company;

    // 1. Organization Identified (max 3)
    if (f.contentOn) {
        if (f.isChecking && !f.contentArrived) {
            checks.push({
                key: "companyIdentified",
                title: "Organization Identified",
                points: 0,
                lost: 0,
                max: MAX.companyIdentified,
                isPending: true,
                reason: "Identifying sender organization…",
                severity: 20,
            });
        } else {
            const idPoints = off ? 0 : contentPoints((d) => d.companyIdentification?.scoreImpact);
            const earnedId = Math.max(0, Math.min(MAX.companyIdentified, idPoints));
            const lostId = Math.max(0, MAX.companyIdentified - earnedId);
            const isGained = earnedId > 0;
            checks.push({
                key: "companyIdentified",
                title: isGained ? "Organization Identified" : "No Organization Identified",
                points: earnedId,
                lost: lostId,
                max: MAX.companyIdentified,
                isGained,
                reason: isGained
                    ? (company ? `Recognized claimed sender as ${company}.` : "Recognized legitimate sender organization.")
                    : (off ? "Analysis could not run." : "No specific organization or company was identified in the email."),
                severity: 20,
            });
        }
    }

    // 2. Domain Checks (No Domain Spoofing / Unregistered Domain / Official Domain) (max 30)
    if (f.on("checkDomain")) {
        if (f.isChecking && !f.domainArrived) {
            checks.push({
                key: "domainSpoofing",
                title: "No Domain Spoofing",
                points: 0,
                lost: 0,
                max: MAX.domain,
                isPending: true,
                reason: "Checking sender domain against known brand names…",
                severity: 55,
            });
        } else {
            const d = f.domain || {};
        const sd = f.senderDomain || "Sender domain";
        const impact = typeof d.scoreImpact === "number" ? d.scoreImpact : 0;
        const earned = Math.max(0, Math.min(MAX.domain, impact));
        const lost = Math.max(0, MAX.domain - earned);

        if (d.status === "DomainExactMatch") {
            checks.push({
                key: "domain",
                title: "Official Domain",
                points: earned,
                lost: 0,
                max: MAX.domain,
                isGained: true,
                reason: f.verified && f.company
                    ? `Domain "${sd}" is an official domain owned by ${f.company}.`
                    : `Domain "${sd}" matches a verified, authentic company entry.`,
                severity: 0,
            });
        } else if (d.status === "DomainNoSimilarity") {
            // Earned points for not spoofing known brands
            checks.push({
                key: "domainSpoofing",
                title: "No Domain Spoofing",
                points: earned,
                lost: 0,
                max: earned,
                isGained: true,
                reason: `Domain "${sd}" does not mimic known brand names.`,
                severity: 55,
            });
            // Lost points for not being registered in official business registries
            if (lost > 0) {
                checks.push({
                    key: "unregisteredDomain",
                    title: "Unregistered Domain",
                    points: 0,
                    lost,
                    max: lost,
                    isGained: false,
                    reason: `Domain "${sd}" is not recognized in official business registries.`,
                    severity: 55,
                });
            }
        } else if (d.status === "freeMailMatch") {
            checks.push({
                key: "webmail",
                title: "Standard Public Webmail",
                points: earned,
                lost: 0,
                max: earned,
                isGained: true,
                reason: `Sent through a standard email provider (${sd}).`,
                severity: 60,
            });
            if (lost > 0) {
                checks.push({
                    key: "freeMail",
                    title: "Free Webmail Address",
                    points: 0,
                    lost,
                    max: lost,
                    isGained: false,
                    reason: `Sent from a free email address (${sd}) instead of an official company domain.`,
                    severity: 60,
                });
            }
        } else if (d.status === "DomainImpersonation") {
            checks.push({
                key: "domainImpersonation",
                title: "Domain Impersonation",
                points: 0,
                lost,
                max: MAX.domain,
                isGained: false,
                reason: `Domain "${sd}" mimics "${d.matchedDomain}" to impersonate them.`,
                severity: 95,
            });
        } else if (d.status === "AppointmentNotification") {
            checks.push({
                key: "appointmentNotification",
                title: "Booking Service",
                points: earned,
                lost: 0,
                max: earned || MAX.domain,
                isGained: true,
                reason: `Domain "${sd}" sends appointment notifications.`,
                severity: 65,
            });
            if (lost > 0) {
                checks.push({
                    key: "appointmentDomainNotice",
                    title: "Booking Service Domain",
                    points: 0,
                    lost,
                    max: lost,
                    isGained: false,
                    reason: `Automated booking service; unexpected if you did not schedule an appointment.`,
                    severity: 65,
                });
            }
        } else if (d.status === "Error") {
            checks.push({
                key: "domainError",
                title: "Domain Check Failed",
                points: 0,
                lost: MAX.domain,
                max: MAX.domain,
                isGained: false,
                reason: "Sender domain could not be verified.",
                severity: 40,
            });
        } else {
            if (earned >= MAX.domain) {
                checks.push({
                    key: "domain",
                    title: "Domain Verified",
                    points: earned,
                    lost: 0,
                    max: MAX.domain,
                    isGained: true,
                    reason: `Domain "${sd}" verified.`,
                    severity: 0,
                });
            } else if (earned > 0 && lost > 0) {
                checks.push({
                    key: "domainSpoofing",
                    title: "No Domain Spoofing",
                    points: earned,
                    lost: 0,
                    max: earned,
                    isGained: true,
                    reason: `Domain "${sd}" does not mimic known brand names.`,
                    severity: 55,
                });
                checks.push({
                    key: "unregisteredDomain",
                    title: "Unregistered Domain",
                    points: 0,
                    lost,
                    max: lost,
                    isGained: false,
                    reason: `Domain "${sd}" is not recognized in official business registries.`,
                    severity: 55,
                });
            } else {
                checks.push({
                    key: "domain",
                    title: "Unregistered Domain",
                    points: 0,
                    lost: MAX.domain,
                    max: MAX.domain,
                    isGained: false,
                    reason: `Domain "${sd}" is not recognized in official business registries.`,
                    severity: 55,
                });
            }
        }
    }
    }

    // 3. Verified Phone Number (max 4)
    if (f.contentOn) {
        if (f.isChecking && !f.contentArrived) {
            checks.push({
                key: "phone",
                title: "Verified Phone Number",
                points: 0,
                lost: 0,
                max: MAX.phone,
                isPending: true,
                reason: "Checking contact phone numbers…",
                severity: 15,
            });
        } else {
            const phonePoints = off ? 0 : contentPoints((d) => d.contactMethodAnalysis?.scoreImpact);
            const earnedPhone = Math.max(0, Math.min(MAX.phone, phonePoints));
            const lostPhone = Math.max(0, MAX.phone - earnedPhone);
            let title = "No Phone Number Found";
            let reason = "No contact phone numbers found in the email.";
            let isGained = earnedPhone > 0;
            let severity = 15;

            if (f.validPhones.length > 0) {
                title = "Verified Phone Number";
                reason = `Phone number (${f.validPhones[0]}) matches official records for ${company || "the sender"}.`;
                isGained = true;
            } else if (f.invalidPhones.length > 0) {
                title = "Unverified Phone Number";
                reason = company
                    ? `Phone number (${f.invalidPhones[0]}) does not match official records for ${company}.`
                    : `Phone number (${f.invalidPhones[0]}) could not be linked to the sender.`;
                isGained = false;
                severity = 70;
            }

            checks.push({
                key: "phone",
                title,
                points: earnedPhone,
                lost: lostPhone,
                max: MAX.phone,
                isGained,
                reason: off ? "Analysis could not run." : reason,
                severity,
            });
        }
    }

    // 4. Safe Links (max 10)
    if (f.urlsOn) {
        if (f.isChecking && !f.urlsArrived) {
            const count = f.urlCount || 0;
            checks.push({
                key: "urls",
                title: "Safe Links",
                points: 0,
                lost: 0,
                max: MAX.urls,
                isPending: true,
                reason: count === 0
                    ? "Scanning links for security threats…"
                    : count === 1
                        ? "Scanning 1 link for security threats…"
                        : `Scanning ${count} links for security threats…`,
                severity: 0,
            });
        } else {
            const earnedUrl = Math.max(0, Math.min(MAX.urls, r.urlAnalysis?.scoreImpact || 0));
            const lostUrl = Math.max(0, MAX.urls - earnedUrl);
            const count = f.urlCount || 0;
            let title = "Safe Links";
            let reason;

            if (f.skippedSensitiveCount > 0) {
                const suffix = f.skippedSensitiveCount === 1 ? "to keep your link valid." : "to keep your links valid.";
                reason = f.urlMessage || (count === 0
                    ? (f.skippedSensitiveCount === 1
                        ? `1 sensitive link skipped (${f.skippedReasonSummary || "sensitive"}) ${suffix}`
                        : `${f.skippedSensitiveCount} sensitive links skipped (${f.skippedReasonSummary || "sensitive"}) ${suffix}`)
                    : (count === 1
                        ? `1 link scanned clean. ${f.skippedSensitiveCount} sensitive link(s) skipped ${suffix}`
                        : `All ${count} links scanned clean. ${f.skippedSensitiveCount} sensitive link(s) skipped ${suffix}`));
            } else {
                reason = count === 0
                    ? "No external links found in the email."
                    : count === 1
                        ? "1 link scanned clean with no security threats."
                        : `All ${count} links scanned clean with no security threats.`;
            }
            let isGained = earnedUrl > 0;
            let severity = 0;

            if (f.maliciousCount > 0) {
                title = "Dangerous Links Detected";
                reason = f.maliciousCount === 1
                    ? "1 link flagged as malicious or phishing."
                    : `${f.maliciousCount} links flagged as malicious or phishing.`;
                isGained = false;
                severity = 100;
            } else if (f.urlsServerDisabled) {
                title = "URL Scanning Disabled";
                reason = "URL scanning is turned off on the server.";
                isGained = false;
                severity = 35;
            } else if (f.urlErrorCount > 0 && f.maliciousCount === 0) {
                title = "Link Scan Incomplete";
                reason = f.urlErrorCount === 1
                    ? "1 link could not be scanned."
                    : `${f.urlErrorCount} of ${count} links could not be scanned.`;
                isGained = false;
                severity = 40;
            }

            checks.push({
                key: "urls",
                title,
                points: earnedUrl,
                lost: lostUrl,
                max: MAX.urls,
                isGained,
                reason,
                severity,
            });
        }
    }

    // 5. Safe Attachments (max 3)
    if (f.attachmentsOn) {
        if (f.isChecking && !f.attachmentsArrived) {
            checks.push({
                key: "attachments",
                title: "Safe Attachments",
                points: 0,
                lost: 0,
                max: MAX.attachments,
                isPending: true,
                reason: "Scanning attachments for dangerous files…",
                severity: 0,
            });
        } else {
            const earnedAtt = Math.max(0, Math.min(MAX.attachments, r.attachments?.scoreImpact || 0));
            const lostAtt = Math.max(0, MAX.attachments - earnedAtt);
            const isGained = earnedAtt > 0 && !f.attachmentFound;
            checks.push({
                key: "attachments",
                title: isGained ? "Safe Attachments" : "Dangerous Attachment Found",
                points: earnedAtt,
                lost: lostAtt,
                max: MAX.attachments,
                isGained,
                reason: isGained
                    ? "No dangerous executable files or scripts attached."
                    : `Attached file (${f.attachmentName || "executable"}) could run code on your device.`,
                severity: isGained ? 0 : 100,
            });
        }
    }

    // 6. Sender Address Verified (max 20)
    if (f.contentOn) {
        if (f.isChecking && !f.contentArrived) {
            checks.push({
                key: "companyVerified",
                title: "Sender Address Verified",
                points: 0,
                lost: 0,
                max: MAX.companyVerified,
                isPending: true,
                reason: "Verifying sender address matches claimed organization…",
                severity: 30,
            });
        } else {
            const verPoints = off ? 0 : contentPoints((d) => d.companyVerification?.scoreImpact);
            const earnedVer = Math.max(0, Math.min(MAX.companyVerified, verPoints));
            const lostVer = Math.max(0, MAX.companyVerified - earnedVer);
            let title = "Sender Address Verified";
            let reason = company
                ? `Sender domain verified as belonging to ${company}.`
                : "Sender domain matches the claimed organization.";
            let isGained = earnedVer > 0 && f.verified;
            let severity = 0;

            if (company && !f.verified) {
                title = "Sender Address Mismatch";
                reason = f.officialDomain
                    ? `Claims to be ${company}, but sent from an unauthorized domain (${f.senderDomain || "unverified"}). Official domain is ${f.officialDomain}.`
                    : `Claims to be ${company}, but was sent from an unrelated domain (${f.senderDomain || "unverified"}).`;
                isGained = false;
                severity = 90;
            } else if (f.impersonation) {
                title = "Sender Address Mismatch";
                reason = `Sender address does not belong to ${company || "the claimed organization"}.`;
                isGained = false;
                severity = 90;
            } else if (!f.verified) {
                title = "Organization Not Verified";
                reason = "Sender address could not be verified against any known organization.";
                isGained = false;
                severity = 30;
            }

            checks.push({
                key: "companyVerified",
                title,
                points: earnedVer,
                lost: lostVer,
                max: MAX.companyVerified,
                isGained,
                reason: off ? "Analysis could not run." : reason,
                severity,
            });
        }
    }

    // 7. Legitimate Tone & Content (max 25)
    if (f.contentOn) {
        if (f.isChecking && !f.contentArrived) {
            checks.push({
                key: "realism",
                title: "Legitimate Tone & Content",
                points: 0,
                lost: 0,
                max: MAX.realism,
                isPending: true,
                reason: "Analyzing email tone, wording, and urgency…",
                severity: 85,
            });
        } else {
            const realPoints = off ? 0 : contentPoints((d) => d.realismAnalysis?.scoreImpact);
            const earnedReal = Math.max(0, Math.min(MAX.realism, realPoints));
            const lostReal = Math.max(0, MAX.realism - earnedReal);
            const cleanRealism = f.realismReason ? truncate(f.realismReason, 120) : "";
            const isGained = earnedReal > 0 && f.unrealistic.length === 0;
            checks.push({
                key: "realism",
                title: isGained ? "Legitimate Tone & Content" : "Suspicious or Deceptive Wording",
                points: earnedReal,
                lost: lostReal,
                max: MAX.realism,
                isGained,
                reason: off
                    ? "Analysis could not run."
                    : (isGained ? "Wording reads naturally with no signs of phishing, manipulation, or urgency." : (cleanRealism || "Uses false urgency, threats, or claims typical of phishing scams.")),
                severity: isGained ? 0 : 85,
            });
        }
    }

    return checks;
}

export function buildReport(results) {
    const f = gatherFacts(results);
    const checks = buildChecks(f);
    const max = results.maxScore || checks.reduce((a, c) => a + c.max, 0) || 95;
    const earned = Math.round(checks.reduce((a, c) => a + (c.isPending ? 0 : c.points), 0) * 10) / 10;
    const pct = max > 0 ? Math.round(Math.max(0, Math.min(100, (earned / max) * 100))) : null;

    if (f.isChecking) {
        return {
            isChecking: true,
            verdict: null,
            pct: pct || 0,
            earned,
            max,
            checks,
            theme: {
                color: "#0d8a4f",
                ink: "#002B4D",
                heroBg: "#f8fafc",
                badge: { bg: "#f1f5f9", border: "#cbd5e1" },
                glyph: "",
            },
            title: "Analyzing email…",
            sub: "Checking sender domain, links, attachments, and content realism.",
            actionTip: null,
            urls: f.urls.map((u) => ({
                kind: u.kind,
                url: u.url,
                report: /^https:\/\/www\.virustotal\.com\//.test(u.report) ? u.report : "",
                engines: u.kind === "error" ? "failed" : u.kind === "skipped" ? "skipped" : `${u.flagged || 0} flagged`,
                reason: u.reason || "",
            })),
            urlsOn: f.urlsOn,
            urlCount: f.urlCount,
            maliciousCount: f.maliciousCount,
            skippedSensitiveCount: f.skippedSensitiveCount,
        };
    }

    const verdict = verdictForPercent(pct);

    if (!verdict) {
        return { verdict: null, pct: null, checks };
    }

    const theme = VERDICTS[verdict];

    // Build concise, clear summary
    let sub;
    if (verdict === "safe") {
        sub = f.company && f.verified
            ? `Sender address matches official records for ${f.company}. Passed all security checks.`
            : "Passed security checks with no phishing or malware indicators detected.";
    } else if (verdict === "suspicious") {
        const topFailed = checks.find((c) => !c.isGained && c.severity >= 50);
        sub = topFailed
            ? `Suspicious: ${topFailed.reason}`
            : "Some checks could not be confirmed. Treat this email with caution.";
    } else {
        // High risk
        if (f.impersonation) {
            sub = `Impersonation detected: sender is imitating ${f.company || f.domain?.matchedDomain}.`;
        } else if (f.maliciousCount > 0) {
            sub = "Dangerous email: contains links flagged as malicious or phishing.";
        } else {
            const topFailed = checks.find((c) => !c.isGained && c.severity >= 70);
            sub = topFailed
                ? `High risk: ${topFailed.reason}`
                : "Strong signs of phishing or deception detected.";
        }
    }

    // Short action tip
    let actionTip = null;
    if (verdict === "highrisk") {
        actionTip = f.attachmentFound
            ? "Do not click links, open attachments, or reply to this sender."
            : "Do not click any links or enter passwords on pages linked here.";
    } else if (verdict === "suspicious") {
        actionTip = "Verify the sender through a known trusted channel before acting.";
    }

    let interstitial = null;
    if (verdict === "highrisk") {
        interstitial = {
            title: theme.title,
            body: `${sub} ${actionTip || "Do not interact with this email."}`,
        };
    }

    return {
        verdict,
        pct,
        earned,
        max,
        checks,
        theme,
        title: theme.title,
        sub,
        actionTip,
        badge: {
            ...theme.badge,
            dot: theme.color,
            ink: theme.ink,
            glyph: theme.glyph,
            sub: `${pct}% score`,
        },
        interstitial,
        urls: f.urls.map((u) => ({
            kind: u.kind,
            url: u.url,
            report: /^https:\/\/www\.virustotal\.com\//.test(u.report) ? u.report : "",
            engines: u.kind === "error" ? "failed" : u.kind === "skipped" ? "skipped" : `${u.flagged || 0} flagged`,
            reason: u.reason || "",
        })),
        urlsOn: f.urlsOn,
        urlCount: f.urlCount,
        maliciousCount: f.maliciousCount,
        skippedSensitiveCount: f.skippedSensitiveCount,
    };
}
