// Local cache manager for email verification results.
// Persists results in chrome.storage.local (with fallback to localStorage / in-memory)
// so that previously analyzed emails render immediately without contacting the backend.

const MEMORY_CACHE = new Map();
const CACHE_PREFIX = "ec_cache_";
const INDEX_KEY = "ec_cache_index";
const MAX_CACHED_EMAILS = 100;

function hasChromeStorage() {
    return typeof chrome !== "undefined" && !!chrome?.storage?.local;
}

function hasLocalStorage() {
    try {
        return typeof localStorage !== "undefined" && localStorage !== null;
    } catch {
        return false;
    }
}

function sanitizeCachedEntry(data) {
    if (!data) return null;
    if (typeof data.html === "string" && data.html.includes("ec-btn-rerun")) {
        data.html = data.html.replace(/<button[^>]*class="[^"]*ec-btn-rerun[^"]*"[^>]*>[\s\S]*?<\/button>/gi, "");
    }
    return data;
}

/**
 * Fast synchronous check in the in-memory L1 cache.
 * Useful for hot-path lookups like MutationObserver.
 */
export function getCachedAnalysisSync(emailKey) {
    if (!emailKey) return null;
    return sanitizeCachedEntry(MEMORY_CACHE.get(String(emailKey))) || null;
}

/**
 * Asynchronous lookup: checks in-memory cache first, then chrome.storage.local / localStorage.
 */
export async function getCachedAnalysis(emailKey) {
    if (!emailKey) return null;
    const key = String(emailKey);

    // 1. Fast in-memory check
    if (MEMORY_CACHE.has(key)) {
        return sanitizeCachedEntry(MEMORY_CACHE.get(key));
    }

    // 2. Persistent storage check
    const storageKey = CACHE_PREFIX + key;

    if (hasChromeStorage()) {
        try {
            const data = await new Promise((resolve) => {
                chrome.storage.local.get([storageKey], (res) => {
                    resolve(res ? res[storageKey] : null);
                });
            });
            if (data) {
                const clean = sanitizeCachedEntry(data);
                MEMORY_CACHE.set(key, clean);
                return clean;
            }
        } catch (e) {
            console.warn("EmailChecker: Error reading from chrome.storage.local:", e);
        }
    } else if (hasLocalStorage()) {
        try {
            const raw = localStorage.getItem(storageKey);
            if (raw) {
                const data = JSON.parse(raw);
                const clean = sanitizeCachedEntry(data);
                MEMORY_CACHE.set(key, clean);
                return clean;
            }
        } catch (e) {
            console.warn("EmailChecker: Error reading from localStorage:", e);
        }
    }

    return null;
}

/**
 * Saves analysis results for an email in both in-memory and persistent storage.
 */
export async function saveCachedAnalysis(emailKey, entry) {
    if (!emailKey || !entry) return;
    const key = String(emailKey);

    const data = {
        ...entry,
        key,
        cachedAt: Date.now(),
    };

    // 1. Update in-memory L1 cache
    MEMORY_CACHE.set(key, data);

    // 2. Update persistent storage (with LRU eviction to prevent unbounded storage)
    const storageKey = CACHE_PREFIX + key;

    if (hasChromeStorage()) {
        try {
            const index = await new Promise((resolve) => {
                chrome.storage.local.get([INDEX_KEY], (res) => {
                    resolve((res && Array.isArray(res[INDEX_KEY])) ? res[INDEX_KEY] : []);
                });
            });

            const newIndex = [key, ...index.filter((k) => k !== key)];
            const toRemove = [];

            while (newIndex.length > MAX_CACHED_EMAILS) {
                const evictedKey = newIndex.pop();
                MEMORY_CACHE.delete(evictedKey);
                toRemove.push(CACHE_PREFIX + evictedKey);
            }

            const payload = {
                [storageKey]: data,
                [INDEX_KEY]: newIndex,
            };

            await new Promise((resolve) => {
                chrome.storage.local.set(payload, resolve);
            });

            if (toRemove.length > 0) {
                chrome.storage.local.remove(toRemove);
            }
        } catch (e) {
            console.warn("EmailChecker: Error writing to chrome.storage.local:", e);
        }
    } else if (hasLocalStorage()) {
        try {
            localStorage.setItem(storageKey, JSON.stringify(data));
        } catch (e) {
            console.warn("EmailChecker: Error writing to localStorage:", e);
        }
    }
}

/**
 * Removes cached analysis for an email (used on rerun or auth invalidation).
 */
export async function removeCachedAnalysis(emailKey) {
    if (!emailKey) return;
    const key = String(emailKey);

    MEMORY_CACHE.delete(key);
    const storageKey = CACHE_PREFIX + key;

    if (hasChromeStorage()) {
        try {
            const index = await new Promise((resolve) => {
                chrome.storage.local.get([INDEX_KEY], (res) => {
                    resolve((res && Array.isArray(res[INDEX_KEY])) ? res[INDEX_KEY] : []);
                });
            });
            const newIndex = index.filter((k) => k !== key);
            await new Promise((resolve) => {
                chrome.storage.local.remove([storageKey], resolve);
            });
            chrome.storage.local.set({ [INDEX_KEY]: newIndex });
        } catch (e) {
            console.warn("EmailChecker: Error removing from chrome.storage.local:", e);
        }
    } else if (hasLocalStorage()) {
        try {
            localStorage.removeItem(storageKey);
        } catch (e) {
            console.warn("EmailChecker: Error removing from localStorage:", e);
        }
    }
}

/**
 * Clears all cached email analyses.
 */
export async function clearAllAnalysisCache() {
    MEMORY_CACHE.clear();

    if (hasChromeStorage()) {
        try {
            const index = await new Promise((resolve) => {
                chrome.storage.local.get([INDEX_KEY], (res) => {
                    resolve((res && Array.isArray(res[INDEX_KEY])) ? res[INDEX_KEY] : []);
                });
            });
            const keysToRemove = [INDEX_KEY, ...index.map((k) => CACHE_PREFIX + k)];
            await new Promise((resolve) => {
                chrome.storage.local.remove(keysToRemove, resolve);
            });
        } catch (e) {
            console.warn("EmailChecker: Error clearing chrome.storage.local:", e);
        }
    } else if (hasLocalStorage()) {
        try {
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(CACHE_PREFIX)) keysToRemove.push(k);
            }
            keysToRemove.forEach((k) => localStorage.removeItem(k));
        } catch (e) {
            console.warn("EmailChecker: Error clearing localStorage:", e);
        }
    }
}

/**
 * Computes a fast string hash for raw EML content when a messageId is not available.
 */
export function hashString(str) {
    if (!str) return "0";
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
        hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
}
