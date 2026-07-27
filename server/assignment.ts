// Bridges the lookcam assignment reader into this server.
//
// The reader (lookcam/assignment) runs beside the camera stack and already
// exposes the transcribed assignment as markdown + LaTeX, so it drops straight
// into the same markdown → tiles pipeline as solution.md. This module owns:
//
//   - ONE upstream SSE connection, shared by every glasses client
//   - a document view: the markdown, versioned by content hash
//   - a status view: job state + the model's camera advice ("move_down", …)
//   - control(): start | stop | reset | restart | extend, and a toggle() that
//     picks the sensible one from live job state
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

/** One scan attempt, live or filed away — see the reader's /archive. */
export interface ArchiveEntry {
    version: number;
    created_at: string;
    updated_at: string;
    capture_count: number;
    done: boolean;
    problems: number;
    title: string;
    /** False for the attempt still in progress. */
    archived: boolean;
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
    /** The reader's current attempt number; bumps on every reset. */
    version: number;
    /**
     * Every attempt the reader still holds, newest first, live one at the head.
     * The glasses' version picker is built from this — the same role
     * `solution_history` plays on the AI page.
     */
    versions: ArchiveEntry[];
    /** When the last capture landed, so the glasses can age it. */
    last_capture_at: number | null;
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
    version: 0,
    versions: [],
    last_capture_at: null,
};

export function getStatus(): Status {
    return { ...status };
}

// ── the archive ─────────────────────────────────────────────────────────────
//
// Refreshed on connect and on every `reset`, which are the only two moments the
// filed-away list can change — a running job only moves the LIVE entry, and
// everything about that is already in `status`. Polling it on each status build
// would put an upstream round trip behind a payload the glasses ask for several
// times a second.

async function refreshArchive(): Promise<void> {
    if (!isConfigured()) return;
    try {
        const res = await fetch(`${BASE_URL}/archive`, { headers: authHeaders() });
        if (!res.ok) throw new Error(`archive HTTP ${res.status}`);
        const body = (await res.json()) as { versions?: ArchiveEntry[] };
        status.versions = Array.isArray(body.versions) ? body.versions : [];
        if (status.versions[0] && !status.version) {
            status.version = status.versions[0].version;
        }
        notifyStatus();
    } catch (err) {
        // A reader that predates /archive answers 404. The picker is then simply
        // empty, which is the truthful thing for it to be.
        console.error("[assignment] archive list failed:", err);
    }
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

/**
 * One filed-away attempt, as a document source.
 *
 * Frozen by definition — an archived scan is a file the reader will never write
 * again — so `subscribe` has nothing to report and the tile cache built on top
 * renders it exactly once, however many times the glasses page back to it.
 *
 * The LIVE version must not come through here: use `assignmentSource` for that,
 * or the page stops following the scan it is watching happen.
 */
const archivedSources = new Map<number, DocSource>();

export function archivedSource(version: number): DocSource {
    let source = archivedSources.get(version);
    if (source) return source;
    source = {
        name: `assignment v${version}`,
        async read(): Promise<Snapshot> {
            const res = await fetch(`${BASE_URL}/archive/${version}.md`, {
                headers: authHeaders(),
            });
            if (!res.ok) throw new Error(`archive v${version} HTTP ${res.status}`);
            const content = await res.text();
            return { content, version: hashContent(content) };
        },
        subscribe: () => () => {},
    };
    archivedSources.set(version, source);
    return source;
}

/** The reader's archive listing, for the route that exposes it directly. */
export function getArchive(): ArchiveEntry[] {
    return status.versions;
}

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
            status.version = Number(d.version ?? status.version);
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
            status.last_capture_at = Date.now();
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
            status.last_capture_at = null;
            status.version = Number(d.version ?? status.version + 1);
            // The attempt that just ended is now a file; the picker gains an entry.
            void refreshArchive();
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
                // Also catches resets that happened while we were disconnected.
                void refreshArchive();
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

/** How much extra budget "extend" buys past a `max_captures` stop. */
const EXTEND_BY = 20;

/**
 * What the caller asks for. Everything except `toggle` is literal — the glasses
 * menu names these directly, so the reader's state machine can't surprise it.
 *
 *   start    begin, or resume into the existing transcription
 *   stop     end the running job, keeping what's been read
 *   reset    archive the attempt and clear, without spending a capture
 *   restart  reset, then start — a rescan from scratch
 *   extend   raise the capture ceiling and carry on (the `max_captures` exit)
 *   none     deliberately nothing; what a tap resolves to when the only thing
 *            left to do would destroy the transcription (see defaultAction)
 *   toggle   whichever of the above fits the current state (the tap gesture)
 */
export type ControlAction =
    | "start"
    | "stop"
    | "reset"
    | "restart"
    | "extend"
    | "none"
    | "toggle";

export interface ControlResult {
    ok: boolean;
    /** What we actually did, so the caller can label its button. */
    action:
        | "started"
        | "stopped"
        | "reset"
        | "restarted"
        | "extended"
        | "nothing"
        | "failed";
    detail?: string;
}

/** @deprecated name kept for the tap path; `control` is the general form. */
export type ToggleResult = ControlResult;

const fail = (detail: string): ControlResult => ({ ok: false, action: "failed", detail });

/** POST that turns a non-2xx into the message we'd want to read on the glasses. */
async function call(path: string, body?: unknown): Promise<string | null> {
    const res = await post(path, body);
    if (res.ok) return null;
    const text = await res.text().catch(() => "");
    return text.slice(0, 200) || `${path} HTTP ${res.status}`;
}

/** The reader answers 409 with a JSON blob; unreadable in a two-line box. */
const BUSY = "a job is already running";

/**
 * Every control the glasses can ask for, in one call.
 *
 * The reader's endpoints are individually simple but their preconditions are
 * not: /start answers 409 both while a job runs AND once the assignment is
 * complete, and after a `max_captures` stop it "succeeds" while doing nothing —
 * the ceiling counts captures per version, so the job re-finishes immediately.
 * Composing that here, where the live job state already is, keeps the branching
 * out of the glasses app.
 */
export async function control(action: ControlAction): Promise<ControlResult> {
    if (!isConfigured()) return fail("ASSIGNMENT_URL not set");

    try {
        switch (action) {
            case "toggle":
                return control(defaultAction());

            // Not a failure: there was simply nothing safe to do. `ok` stays
            // true so the glasses don't paint an error over a finished page.
            case "none":
                return {
                    ok: true,
                    action: "nothing",
                    detail: status.done
                        ? "already read - rescan from the menu"
                        : "capture limit reached - use the menu",
                };

            case "stop": {
                const err = await call("/stop");
                if (err) return fail(err);
                status.running = false;
                notifyStatus();
                return { ok: true, action: "stopped" };
            }

            case "reset": {
                const err = await call("/reset");
                if (err) return fail(err);
                // The reader's own `reset` event clears the rest; this just stops
                // the box claiming a job is live until it arrives.
                status.running = false;
                notifyStatus();
                return { ok: true, action: "reset" };
            }

            case "restart": {
                // /reset also stops a running job, so this covers "scrap this and
                // start over" from any state.
                const err = await call("/reset");
                if (err) return fail(err);
                return afterStart(await call("/start"), "restarted");
            }

            case "extend": {
                // Resuming after `max_captures` needs a bigger ceiling or the job
                // ends on the same check it ended on last time.
                if (status.running) return fail(BUSY);
                const err = await call("/start", {
                    max_captures: status.captures + EXTEND_BY,
                });
                return afterStart(err, "extended");
            }

            case "start":
                if (status.running) return fail(BUSY);
                return afterStart(await call("/start"), "started");
        }
    } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}

/** Shared tail of every action that leaves a job running. */
function afterStart(err: string | null, action: ControlResult["action"]): ControlResult {
    if (err) return fail(err);
    status.running = true;
    status.reason = null;
    notifyStatus();
    return { ok: true, action };
}

/**
 * What a plain tap should do, given where the job is.
 *
 * Never anything destructive. A tap used to mean "rescan" once the page was
 * read or the budget spent — and rescanning archives the transcription and
 * starts from nothing, which is a great deal to lose to a temple tap you didn't
 * mean to make, on the one page whose whole purpose is to be finished. Both of
 * those states now do nothing at all, and the menu is where rescanning lives.
 *
 * The remaining tap actions all preserve work: start, resume, stop.
 */
export function defaultAction(): Exclude<ControlAction, "toggle"> {
    if (status.running) return "stop";
    if (status.done || status.reason === "max_captures") return "none";
    return "start";
}

/** The tap gesture: one call, no knowledge of the reader's state machine. */
export const toggle = (): Promise<ControlResult> => control("toggle");
