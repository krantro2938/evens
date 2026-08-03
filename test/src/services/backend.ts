// Backend router: picks the server URL based on the current mode.
//
// Every fetch in the app goes through serverUrl() instead of the static
// MARKDOWN_SERVER_URL constant. The mode (auto / online / offline) decides
// which backend answers:
//
//   online   → the VPS (VITE_MD_SERVER)
//   offline  → a local HTTP server on the phone (Ollama + solver.py)
//   auto     → whichever is reachable, VPS preferred
//
// The mode is persisted in localStorage so it survives reloads AND works
// when the VPS is unreachable (the server copy in /settings/mode is synced
// when online, but can't be the source of truth for an offline boot).

import { appLog } from "../debug";

export type Mode = "auto" | "online" | "offline";

const REMOTE_URL: string = import.meta.env.VITE_MD_SERVER ?? "";
const LOCAL_URL: string = import.meta.env.VITE_LOCAL_SERVER ?? "http://localhost:8384";

const MODE_KEY = "evens:mode";
const ONLINE_KEY = "evens:lastOnline";

let currentMode: Mode = "auto";
let onlineReachable: boolean | null = null;
let probeTimer: ReturnType<typeof setInterval> | null = null;
/** The probe currently in the air, so callers join it instead of starting another. */
let probeInFlight: Promise<boolean> | null = null;

// ── mode management ────────────────────────────────────────────────────────

export function getMode(): Mode {
    return currentMode;
}

export function setMode(mode: Mode): void {
    currentMode = mode;
    try {
        localStorage.setItem(MODE_KEY, mode);
    } catch {}
    appLog("Backend", `mode → ${mode}`);
    syncModeToServer(mode);
}

export function loadMode(): void {
    try {
        const stored = localStorage.getItem(MODE_KEY);
        if (stored === "online" || stored === "offline" || stored === "auto") {
            currentMode = stored;
        }
    } catch {}
}

async function syncModeToServer(mode: Mode): Promise<void> {
    if (!REMOTE_URL) return;
    try {
        await fetch(`${REMOTE_URL}/settings/mode`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ value: mode }),
        });
    } catch {}
}

// ── connectivity probe ─────────────────────────────────────────────────────

const PROBE_INTERVAL_MS = 30_000;

async function probeRemote(): Promise<boolean> {
    if (!REMOTE_URL) return false;
    try {
        const res = await fetch(`${REMOTE_URL}/health`, {
            signal: AbortSignal.timeout(5_000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

export async function probeLocal(): Promise<boolean> {
    if (!LOCAL_URL) return false;
    try {
        const res = await fetch(`${LOCAL_URL}/health`, {
            signal: AbortSignal.timeout(3_000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/** Probes the VPS and updates onlineReachable. Returns whether it changed. */
async function updateConnectivity(): Promise<boolean> {
    // One at a time. `ensureConnectivity` below joins whatever is already in
    // the air rather than opening a second connection to a host which is, by
    // hypothesis, not answering — and the interval must not stack probes on
    // top of a slow one either.
    if (probeInFlight) return probeInFlight;
    probeInFlight = (async () => {
        const wasOnline = onlineReachable;
        onlineReachable = await probeRemote();
        const changed = wasOnline !== onlineReachable;
        if (changed) {
            appLog("Backend", `remote ${onlineReachable ? "up" : "down"}`);
            if (onlineReachable) {
                try {
                    localStorage.setItem(ONLINE_KEY, String(Date.now()));
                } catch {}
            }
        }
        return changed;
    })();
    try {
        return await probeInFlight;
    } finally {
        probeInFlight = null;
    }
}

/**
 * Settle "which server answers" before a caller commits to one.
 *
 * `serverUrl()` has to be synchronous — a dozen call sites build URLs with it —
 * so it answers from `onlineReachable`, and that starts as `null`, meaning
 * nobody has asked yet. `null` resolves to the VPS, which is right when the VPS
 * is there and catastrophic when it isn't: the app opens a page in the first
 * seconds after launch, the fetch goes to a host with no route to it, and a
 * request with no answer coming is not the same as a request that fails. It
 * hangs, for as long as the platform's connect timeout — minutes, or forever
 * behind a captive portal — and the page sits on "Loading..." for all of it.
 *
 * So: before the first document load, wait for the probe to have an opinion.
 * It is bounded by probeRemote's own 5s timeout, which is a wait you can watch
 * happen rather than one you assume has hung.
 */
export async function ensureConnectivity(): Promise<void> {
    if (currentMode !== "auto" || onlineReachable !== null) return;
    await updateConnectivity();
}

/**
 * A real request to the VPS just failed at the network. Fall back to local.
 *
 * Better evidence than the health probe, which only runs twice a minute: this
 * is the request the user is actually waiting on. Without it a document load
 * that timed out was simply retried against the same dead host on the next
 * poll, and the 30s probe was the only thing that could ever change its mind.
 *
 * Only in `auto`. An explicit mode is a decision, and there is nothing to fall
 * back TO in `offline` — reporting the local server unreachable would just be
 * telling the router what it already picked.
 *
 * Returns whether this actually changed which server answers, so a caller can
 * decide whether retrying is worth anything.
 */
export function noteRemoteFailure(): boolean {
    if (currentMode !== "auto" || onlineReachable === false) return false;
    onlineReachable = false;
    appLog("Backend", "remote request failed - using local until the next probe says otherwise");
    return true;
}

/**
 * Whether a rejected request failed at the network, as opposed to being
 * answered with a status nobody wanted.
 *
 * The difference decides whether `noteRemoteFailure` should fire: a 404 from
 * the VPS is a server that is plainly reachable and merely older than this
 * app, and falling back to the phone over one would be a worse page for no
 * reason. A false negative here is safe — it just means we keep waiting for
 * the probe.
 */
export function isNetworkError(err: unknown): boolean {
    if (err instanceof DOMException) {
        return err.name === "TimeoutError" || err.name === "AbortError";
    }
    // What fetch rejects with when the request never got an answer.
    return err instanceof TypeError;
}

export function startProbing(): void {
    if (probeTimer) return;
    void updateConnectivity();
    probeTimer = setInterval(() => void updateConnectivity(), PROBE_INTERVAL_MS);
}

/**
 * A single probe outside the auto-mode loop above — this one runs no matter
 * what mode is selected. For a caller (the dashboard footer) that wants
 * reachability to stay current even in explicit online/offline mode, where
 * startProbing() above never starts. Returns whether it changed.
 */
export async function probeNow(): Promise<boolean> {
    return updateConnectivity();
}

export function stopProbing(): void {
    if (probeTimer) {
        clearInterval(probeTimer);
        probeTimer = null;
    }
}

// ── the router ─────────────────────────────────────────────────────────────

export function serverUrl(): string {
    switch (currentMode) {
        case "online":
            return REMOTE_URL;
        case "offline":
            return LOCAL_URL;
        case "auto":
            return onlineReachable === false ? LOCAL_URL : REMOTE_URL;
    }
}

/**
 * How long a document request gets before it is given up on.
 *
 * Every fetch in this app used to have no deadline at all, which is fine
 * against a server that answers or refuses and useless against one that is
 * simply not there — the case this whole router exists for. Generous enough
 * for the local server's slowest honest answer (a cold tile render on the
 * phone, ~1s, see offline/render.py) and short enough that a page can say so
 * and move on. The solve POST is deliberately NOT routed through here: that
 * one really does take minutes.
 */
export const DOC_TIMEOUT_MS = 10_000;

/**
 * A request to whichever server is currently answering, with a deadline.
 *
 * `path` is relative to that server — "/tiles", "/assignment/status" — so the
 * caller never has to decide which backend it meant.
 */
export function docFetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${serverUrl()}${path}`, {
        ...init,
        signal: AbortSignal.timeout(DOC_TIMEOUT_MS),
    });
}

export function isOffline(): boolean {
    return serverUrl() === LOCAL_URL;
}

export function isOnline(): boolean {
    return serverUrl() === REMOTE_URL;
}

/**
 * The VPS URL, regardless of mode.
 * Services that should always try the cloud (messages, notifications)
 * use this instead of serverUrl().
 */
export function remoteUrl(): string {
    return REMOTE_URL;
}

/** Whether the VPS was reachable on the last probe. */
export function remoteReachable(): boolean {
    return onlineReachable !== false;
}

// ── init ───────────────────────────────────────────────────────────────────

export function initBackend(): void {
    loadMode();
    if (currentMode === "auto") startProbing();
    appLog("Backend", `init mode=${currentMode} remote=${REMOTE_URL} local=${LOCAL_URL}`);
}
