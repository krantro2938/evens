// On-screen log, plus a copy shipped to the document server.
//
// The panel is only readable where there is a DOM to look at — the simulator, or
// devtools attached to the phone's webview. On the glasses themselves the app is
// invisible: whatever the bridge refuses (a rejected page rebuild, a tile push
// that didn't land) is exactly what you most need to see and can't. So every line
// also goes to POST /log, and `curl <server>/log` reads it back.

import { MARKDOWN_SERVER_URL } from "./constants";

const MAX_LOG_LINES = 80;

/** Batched: a line per gesture is fine, a request per line is not. */
const SHIP_INTERVAL_MS = 1_500;
const SHIP_MAX_BATCH = 40;

let logPanel: HTMLPreElement | null = null;
let logBox: HTMLDetailsElement | null = null;
let pending: string[] = [];
let shipTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Whether the log is open. Remembered, because the panel is pinned over the
 * companion app and "collapse it every time I open the app" is not a fix.
 *
 * Closed by default: on the phone this thing sits on top of the tab you are
 * trying to read, and the shipped copy (`curl <server>/log`) is the one anybody
 * actually debugs from.
 */
const OPEN_KEY = "evens.debug.open";

function wasOpen(): boolean {
    try {
        return localStorage.getItem(OPEN_KEY) === "1";
    } catch {
        return false;
    }
}

function rememberOpen(open: boolean): void {
    try {
        localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
        /* a WebView without storage just starts collapsed each time */
    }
}

/** Distinguishes the glasses from the simulator in a shared log. */
const SOURCE = /Android|iPhone|iPad/i.test(navigator.userAgent) ? "device" : "sim";

// Best effort by design: logging must never be the thing that breaks, so a
// failed POST is dropped silently rather than retried or logged (which would
// recurse). keepalive lets the last batch survive the page going away.
function post(lines: string[]): Promise<unknown> {
    return fetch(`${MARKDOWN_SERVER_URL}/log`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: SOURCE, lines }),
        keepalive: true,
    }).catch(() => {});
}

function ship(): void {
    shipTimer = null;
    if (!pending.length) return;
    const lines = pending.slice(0, SHIP_MAX_BATCH);
    pending = pending.slice(SHIP_MAX_BATCH);

    void post(lines);

    if (pending.length) shipTimer = setTimeout(ship, SHIP_INTERVAL_MS);
}

/**
 * Send everything queued, now, and wait for it.
 *
 * For the paths that end the page: the Setup page's restart reloads the
 * WebView, and the lines explaining why are written milliseconds before it —
 * well inside the batch interval, so without this they are the ones that never
 * arrive. Awaited rather than fired off because a reload cancels an in-flight
 * request the same way it cancels a queued one.
 */
export async function flushLog(): Promise<void> {
    if (shipTimer) {
        clearTimeout(shipTimer);
        shipTimer = null;
    }
    while (pending.length) {
        const lines = pending.slice(0, SHIP_MAX_BATCH);
        pending = pending.slice(SHIP_MAX_BATCH);
        await post(lines);
    }
}

function queueForShipping(line: string): void {
    pending.push(line);
    // Bound it: a runaway loop must not turn into unbounded memory.
    if (pending.length > 200) pending = pending.slice(-200);
    if (!shipTimer) shipTimer = setTimeout(ship, SHIP_INTERVAL_MS);
}

/**
 * The panel, inside a `<details>` so it can be got out of the way.
 *
 * It is pinned over whatever is behind it — which on the simulator is nothing,
 * and in the companion app is the tab you are trying to read. Collapsed it is a
 * one-line strip; open it is what it always was. `<details>` rather than a
 * hand-rolled toggle because the disclosure behaviour, the keyboard handling
 * and the arrow all come free and correct.
 */
function getLogPanel() {
    if (logPanel) return logPanel;

    const box = document.createElement("details");
    box.id = "debug-log-box";
    box.open = wasOpen();
    box.style.cssText = [
        "position:fixed",
        "left:12px",
        "right:12px",
        "bottom:12px",
        "margin:0",
        "background:#111",
        "border:1px solid #555",
        "border-radius:8px",
        "color:#9f9",
        "font:12px/1.4 monospace",
        "text-align:left",
        "z-index:9999",
        // Never wider than its own content needs when shut, so a collapsed log
        // is a label in the corner rather than a bar across the screen.
        "max-width:100%",
    ].join(";");

    const summary = document.createElement("summary");
    summary.textContent = "log";
    summary.style.cssText = [
        "padding:6px 10px",
        "cursor:pointer",
        "user-select:none",
        "color:#7a7",
    ].join(";");
    summary.addEventListener("click", () => {
        // Fires before `open` flips, so this reads the state we are going TO.
        rememberOpen(!box.open);
    });

    logPanel = document.createElement("pre");
    logPanel.id = "debug-log";
    logPanel.style.cssText = [
        "max-height:35vh",
        "overflow:auto",
        "margin:0",
        "padding:0 10px 10px",
        "box-sizing:border-box",
        "white-space:pre-wrap",
    ].join(";");

    box.append(summary, logPanel);
    document.body.appendChild(box);
    logBox = box;
    return logPanel;
}

/** How many lines are waiting, so a collapsed log still says something did. */
function updateSummary(count: number): void {
    const summary = logBox?.querySelector("summary");
    if (summary) summary.textContent = `log (${count})`;
}

function format(value: unknown) {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

export function appLog(...values: unknown[]) {
    const line = `[${new Date().toLocaleTimeString()}] ${values.map(format).join(" ")}`;
    console.log(...values);
    queueForShipping(line);

    const panel = getLogPanel();
    const lines = panel.textContent ? panel.textContent.split("\n") : [];
    lines.push(line);
    panel.textContent = lines.slice(-MAX_LOG_LINES).join("\n");
    panel.scrollTop = panel.scrollHeight;
    updateSummary(lines.length);
}
