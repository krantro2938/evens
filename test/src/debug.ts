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
let pending: string[] = [];
let shipTimer: ReturnType<typeof setTimeout> | null = null;

/** Distinguishes the glasses from the simulator in a shared log. */
const SOURCE = /Android|iPhone|iPad/i.test(navigator.userAgent) ? "device" : "sim";

function ship(): void {
    shipTimer = null;
    if (!pending.length) return;
    const lines = pending.slice(0, SHIP_MAX_BATCH);
    pending = pending.slice(SHIP_MAX_BATCH);

    // Best effort by design: logging must never be the thing that breaks, so a
    // failed POST is dropped silently rather than retried or logged (which would
    // recurse). keepalive lets the last batch survive the page going away.
    void fetch(`${MARKDOWN_SERVER_URL}/log`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: SOURCE, lines }),
        keepalive: true,
    }).catch(() => {});

    if (pending.length) shipTimer = setTimeout(ship, SHIP_INTERVAL_MS);
}

function queueForShipping(line: string): void {
    pending.push(line);
    // Bound it: a runaway loop must not turn into unbounded memory.
    if (pending.length > 200) pending = pending.slice(-200);
    if (!shipTimer) shipTimer = setTimeout(ship, SHIP_INTERVAL_MS);
}

function getLogPanel() {
    if (logPanel) return logPanel;

    logPanel = document.createElement("pre");
    logPanel.id = "debug-log";
    logPanel.style.cssText = [
        "position:fixed",
        "left:12px",
        "right:12px",
        "bottom:48px",
        "max-height:35vh",
        "overflow:auto",
        "margin:0",
        "padding:10px",
        "box-sizing:border-box",
        "background:#111",
        "border:1px solid #555",
        "border-radius:8px",
        "color:#9f9",
        "font:12px/1.4 monospace",
        "text-align:left",
        "white-space:pre-wrap",
        "z-index:9999",
    ].join(";");
    document.body.appendChild(logPanel);
    return logPanel;
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
}
