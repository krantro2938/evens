// Bridges the lookcam assignment reader into this server.
//
// The reader (lookcam/assignment) runs beside the camera stack and already
// exposes the transcribed assignment as markdown + LaTeX, so it drops straight
// into the same markdown → tiles pipeline as solution.md. This module owns:
//
//   - ONE upstream SSE connection, shared by every glasses client
//   - a document view: the markdown, versioned by content hash
//   - a status view: job state + the model's camera advice ("move_down", …)
//   - toggle(): start | stop | reset+start, decided from live job state
//
// The reader's API token stays on this side. The glasses app never sees it,
// which matters because EventSource can't set headers — a browser-side client
// would have to carry the token in a query string, i.e. in the app bundle.
//
// Configure with ASSIGNMENT_URL (e.g. http://<vps-ip>:8091) and
// ASSIGNMENT_TOKEN. With ASSIGNMENT_URL unset the whole feature is inert and
// the routes answer 503 — solution.md keeps working untouched.

import { hashContent, type DocSource, type Snapshot } from "./doc";

const BASE_URL = (process.env.ASSIGNMENT_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.ASSIGNMENT_TOKEN ?? "";

// A capture lands every few seconds and each one can rewrite the document. A
// full re-render is ~1-2s of Chromium plus a 4-tile BLE push, so coalesce
// bursts instead of chasing every event.
const DOC_DEBOUNCE_MS = Number(process.env.ASSIGNMENT_DEBOUNCE_MS ?? 2000);
// Status is only text, but it still costs a container upgrade over BLE.
const STATUS_DEBOUNCE_MS = 250;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export function isConfigured(): boolean {
    return BASE_URL !== "";
}

function authHeaders(): Record<string, string> {
    return TOKEN ? { "x-api-token": TOKEN, authorization: `Bearer ${TOKEN}` } : {};
}

// ── status ──────────────────────────────────────────────────────────────────

/** The model's read on framing, straight from the last `model_response`. */
export interface Feedback {
    camera_advice: string;
    advice_detail: string;
    cut_off_edges: string[];
    frame_quality: string;
    confidence: number;
}

export interface Status {
    /** Our connection to the reader, not the reader's own health. */
    upstream: "disabled" | "connecting" | "open" | "error";
    running: boolean;
    done: boolean;
    captures: number;
    max_captures: number;
    /** Why the last job ended: done | stopped | max_captures | failed. */
    reason: string | null;
    problems: number;
    feedback: Feedback | null;
    /** Last capture failure, or the upstream connection error. */
    error: string | null;
}

const status: Status = {
    upstream: isConfigured() ? "connecting" : "disabled",
    running: false,
    done: false,
    captures: 0,
    max_captures: 0,
    reason: null,
    problems: 0,
    feedback: null,
    error: null,
};

export function getStatus(): Status {
    return { ...status };
}

const statusListeners = new Set<() => void>();
const docListeners = new Set<() => void>();

export function subscribeStatus(fn: () => void): () => void {
    statusListeners.add(fn);
    return () => statusListeners.delete(fn);
}

let statusTimer: ReturnType<typeof setTimeout> | null = null;
function notifyStatus(): void {
    if (statusTimer) return;
    statusTimer = setTimeout(() => {
        statusTimer = null;
        for (const fn of statusListeners) fn();
    }, STATUS_DEBOUNCE_MS);
}

// ── the document ────────────────────────────────────────────────────────────

let current: Snapshot | null = null;
let fetchInFlight: Promise<Snapshot> | null = null;

async function fetchMarkdown(): Promise<Snapshot> {
    const res = await fetch(`${BASE_URL}/assignment.md`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`assignment.md HTTP ${res.status}`);
    const content = await res.text();
    return { content, version: hashContent(content) };
}

/**
 * Refetch and, only if the markdown actually changed, publish it. Many captures
 * refine nothing textual ("changes": []), and those must not cost a render.
 */
async function refreshDocument(): Promise<void> {
    if (fetchInFlight) return void (await fetchInFlight.catch(() => {}));
    fetchInFlight = fetchMarkdown();
    try {
        const next = await fetchInFlight;
        if (current?.version === next.version) return;
        current = next;
        for (const fn of docListeners) fn();
    } catch (err) {
        console.error("[assignment] markdown fetch failed:", err);
    } finally {
        fetchInFlight = null;
    }
}

let docTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleDocumentRefresh(): void {
    if (docTimer) clearTimeout(docTimer);
    docTimer = setTimeout(() => {
        docTimer = null;
        void refreshDocument();
    }, DOC_DEBOUNCE_MS);
}

export const assignmentSource: DocSource = {
    name: "assignment",
    async read(): Promise<Snapshot> {
        // Serve the cached copy the SSE feed keeps warm; fetch on demand only
        // when a client asks before the first event has landed.
        if (current) return current;
        current = await fetchMarkdown();
        return current;
    },
    subscribe(onChange: () => void): () => void {
        docListeners.add(onChange);
        return () => docListeners.delete(onChange);
    },
};

// ── upstream SSE ────────────────────────────────────────────────────────────

interface UpstreamEvent {
    event: string;
    data: unknown;
}

function handleUpstream({ event, data }: UpstreamEvent): void {
    const d = (data ?? {}) as Record<string, any>;

    switch (event) {
        case "snapshot":
            status.done = Boolean(d.done);
            status.captures = Number(d.capture_count ?? 0);
            status.problems = Number(d.problems ?? 0);
            status.running = Boolean(d.job?.running);
            status.max_captures = Number(d.job?.max_captures ?? 0);
            status.reason = d.job?.reason ?? null;
            scheduleDocumentRefresh();
            break;

        case "job_started":
        case "job_resumed":
            status.running = true;
            status.reason = null;
            status.error = null;
            status.max_captures = Number(d.max_captures ?? status.max_captures);
            break;

        case "capture_started":
            status.running = true;
            status.captures = Number(d.n ?? status.captures);
            break;

        case "model_response":
            status.feedback = {
                camera_advice: String(d.camera_advice ?? ""),
                advice_detail: String(d.advice_detail ?? ""),
                cut_off_edges: Array.isArray(d.cut_off_edges) ? d.cut_off_edges : [],
                frame_quality: String(d.frame_quality ?? ""),
                confidence: Number(d.confidence ?? 0),
            };
            status.error = null;
            break;

        case "assignment_updated":
            status.captures = Number(d.capture_count ?? status.captures);
            scheduleDocumentRefresh();
            break;

        case "done":
            status.done = true;
            status.problems = Number(d.problems ?? status.problems);
            scheduleDocumentRefresh();
            break;

        case "job_finished":
            status.running = false;
            status.reason = d.reason ?? null;
            scheduleDocumentRefresh();
            break;

        case "capture_failed":
            status.error = String(d.error ?? "capture failed");
            break;

        case "reset":
            status.done = false;
            status.captures = 0;
            status.problems = 0;
            status.feedback = null;
            status.error = null;
            status.reason = null;
            scheduleDocumentRefresh();
            break;

        default:
            return; // ping, capture_discarded, frame_grabbed, model_request …
    }
    notifyStatus();
}

/**
 * Minimal SSE parser over fetch. Hand-rolled rather than using EventSource so
 * the token travels in a header instead of the query string (URLs end up in
 * proxy logs), and so this doesn't depend on the runtime having EventSource.
 */
async function readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });

        let split: number;
        while ((split = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);

            let event = "message";
            const dataLines: string[] = [];
            for (const line of frame.split("\n")) {
                if (line.startsWith(":")) continue; // comment / heartbeat
                if (line.startsWith("event:")) event = line.slice(6).trim();
                else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
            }
            if (!dataLines.length) continue;
            try {
                handleUpstream({ event, data: JSON.parse(dataLines.join("\n")) });
            } catch {
                // Non-JSON payloads (the `retry:` preamble, stray frames) are
                // not worth dropping the connection over.
            }
        }
    }
}

let started = false;

/** Connect to the reader and keep reconnecting for the life of the process. */
export function startUpstream(): void {
    if (started || !isConfigured()) return;
    started = true;

    void (async () => {
        let backoff = RECONNECT_MIN_MS;
        for (;;) {
            try {
                status.upstream = "connecting";
                notifyStatus();
                const res = await fetch(`${BASE_URL}/events`, {
                    headers: { ...authHeaders(), accept: "text/event-stream" },
                });
                if (!res.ok || !res.body) throw new Error(`events HTTP ${res.status}`);

                console.log(`[assignment] connected to ${BASE_URL}`);
                status.upstream = "open";
                status.error = null;
                notifyStatus();
                backoff = RECONNECT_MIN_MS;

                await readStream(res.body);
                throw new Error("upstream closed the stream");
            } catch (err) {
                status.upstream = "error";
                status.error = err instanceof Error ? err.message : String(err);
                notifyStatus();
                console.error(`[assignment] ${status.error} — retrying in ${backoff}ms`);
                await new Promise((r) => setTimeout(r, backoff));
                backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
            }
        }
    })();
}

// ── control ─────────────────────────────────────────────────────────────────

async function post(path: string, body?: unknown): Promise<Response> {
    return fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
    });
}

export interface ToggleResult {
    ok: boolean;
    /** What we actually did, so the caller can label its button. */
    action: "started" | "stopped" | "restarted" | "failed";
    detail?: string;
}

/**
 * One call the glasses can make without knowing the reader's state machine.
 *
 * /start answers 409 both while a job runs AND once the assignment is complete
 * (that one wants /reset first). Deciding here — where the live job state
 * already is — keeps that branching out of the glasses app.
 */
export async function toggle(): Promise<ToggleResult> {
    if (!isConfigured()) return { ok: false, action: "failed", detail: "ASSIGNMENT_URL not set" };

    try {
        if (status.running) {
            const res = await post("/stop");
            if (!res.ok) return { ok: false, action: "failed", detail: `stop HTTP ${res.status}` };
            status.running = false;
            notifyStatus();
            return { ok: true, action: "stopped" };
        }

        // A finished assignment has to be archived before a new pass; without
        // this the glasses would just get a 409 they can't act on.
        const restarting = status.done;
        if (restarting) {
            const res = await post("/reset");
            if (!res.ok) return { ok: false, action: "failed", detail: `reset HTTP ${res.status}` };
        }

        const res = await post("/start");
        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            return { ok: false, action: "failed", detail: detail.slice(0, 200) || `start HTTP ${res.status}` };
        }
        status.running = true;
        status.reason = null;
        notifyStatus();
        return { ok: true, action: restarting ? "restarted" : "started" };
    } catch (err) {
        return {
            ok: false,
            action: "failed",
            detail: err instanceof Error ? err.message : String(err),
        };
    }
}
