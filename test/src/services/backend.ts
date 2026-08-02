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

async function updateConnectivity(): Promise<void> {
    const wasOnline = onlineReachable;
    onlineReachable = await probeRemote();
    if (wasOnline !== onlineReachable) {
        appLog("Backend", `remote ${onlineReachable ? "up" : "down"}`);
        if (onlineReachable) {
            try {
                localStorage.setItem(ONLINE_KEY, String(Date.now()));
            } catch {}
        }
    }
}

export function startProbing(): void {
    if (probeTimer) return;
    void updateConnectivity();
    probeTimer = setInterval(() => void updateConnectivity(), PROBE_INTERVAL_MS);
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
