// What the companion app remembers when the network doesn't answer.
//
// This app runs in a WebView on a phone, on the assignment's own schedule:
// outside, on wifi that drops, on a train, in a room where the VPS is simply
// unreachable. Every tab here is a view onto a server, so without this the
// honest behaviour of all of them is a red error line over an empty pane — and
// the one thing you actually want in that moment is the text you already had.
//
// So each read-only surface keeps its last good copy here, and shows it,
// labelled, when the fetch fails. The glasses already work this way (see
// render/tileCache.ts and DocState.cachedAt); this is the same bargain on the
// phone: never wrong, because it is what the server last said — but "as of
// then" rather than "now", and it says which.
//
// localStorage rather than a Cache/IndexedDB: these are a few kilobytes of
// markdown, the API is synchronous so a cached render costs no frame, and a
// WebView with storage disabled degrades to exactly today's behaviour.

const PREFIX = "evens.companion.cache.";

export interface Cached<T> {
    value: T;
    /** When the server said it. */
    at: number;
}

export function readCache<T>(key: string): Cached<T> | null {
    try {
        const raw = localStorage.getItem(PREFIX + key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Cached<T>;
        // A half-written or older-shaped entry is not worth a crash on load.
        if (!parsed || typeof parsed.at !== "number") return null;
        return parsed;
    } catch {
        return null;
    }
}

export function writeCache<T>(key: string, value: T): void {
    try {
        localStorage.setItem(PREFIX + key, JSON.stringify({ value, at: Date.now() } satisfies Cached<T>));
    } catch {
        /* full, or storage disabled — the app just stops having a fallback */
    }
}

export function dropCache(key: string): void {
    try {
        localStorage.removeItem(PREFIX + key);
    } catch {
        /* nothing to do */
    }
}

/**
 * True when the browser is sure there is no network.
 *
 * Only useful in the negative: `onLine === true` means "an interface is up",
 * not "the server is reachable", which is why nothing here waits for it before
 * trying. It is worth having for the message — "you are offline" is a better
 * thing to read than "Failed to fetch".
 */
export function offline(): boolean {
    return typeof navigator !== "undefined" && navigator.onLine === false;
}
