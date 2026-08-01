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

/** The reader's unit of coverage — see `edges_unseen` on Status. */
const SHEET_EDGES = ["top", "bottom", "left", "right"] as const;

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
    /**
     * Where to point next, in the model's own words — the sheet is read a piece
     * at a time and this names the piece it still needs ("show the bottom of
     * the page, below problem 7"). `camera_advice` is the direction; this is
     * the destination, and it is the thing worth reading on the glasses.
     */
    next_target: string;
    /** Display-safe target, limited by the reader to the glasses HUD width. */
    next_target_short: string;
    /** Where the last frame sat on the sheet ("top third"). */
    region: string;
    /** Directions in which writing ran off the last frame. */
    more_content_beyond: string[];
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
    /** Of those, how many the model says it has in full. */
    problems_complete: number;
    /** Whether any frame this attempt has shown the whole sheet. Rare and not
     *  required: the camera reads a sheet in pieces. See `edges_unseen`. */
    full_page_seen: boolean;
    /**
     * Edges of the PAPER no frame has shown yet, out of top/bottom/left/right.
     *
     * The reader's gate on `done`, and the honest answer to "is this all of
     * it". Empty means the scan has been from edge to edge of the sheet — over
     * however many partial frames it took, which is the only way it ever
     * happens on a camera close enough to read handwriting.
     */
    edges_unseen: string[];
    /** Where the reader last asked the operator to point. Mirrors
     *  `feedback.next_target`, kept when the feedback is cleared. */
    next_target: string;
    next_target_short: string;
    feedback: Feedback | null;
    /** Last capture failure, or the upstream connection error. */
    error: string | null;
    /** The reader's current attempt number; bumps on every reset. */
    version: number;
    /**
     * Which scan the solve button sends to the AI, as a reader attempt number.
     *
     * `null` — the default, and where it returns on every reset — means whatever
     * the camera is reading now. A number pins it to one filed-away scan, so you
     * can solve the sheet you photographed an hour ago without pointing the
     * camera back at it.
     *
     * Deliberately NOT the same selection as the one the picker uses to read an
     * archived scan: paging back through old scans is looking, and looking
     * should not quietly change what the button does. This only moves when
     * something asks it to.
     */
    active_version: number | null;
    /**
     * Every attempt the reader still holds, newest first, live one at the head.
     * The glasses' version picker is built from this — the same role
     * `solution_history` plays on the AI page.
     */
    versions: ArchiveEntry[];
    /** When the last capture landed, so the glasses can age it. */
    last_capture_at: number | null;
    batch: {
        active: boolean;
        processing: boolean;
        snapshot_count: number;
        max_snapshots: number;
    };
}

const status: Status = {
    upstream: isConfigured() ? "connecting" : "disabled",
    running: false,
    done: false,
    captures: 0,
    max_captures: 0,
    reason: null,
    problems: 0,
    problems_complete: 0,
    full_page_seen: false,
    edges_unseen: [...SHEET_EDGES],
    next_target: "",
    next_target_short: "",
    feedback: null,
    error: null,
    version: 0,
    active_version: null,
    versions: [],
    last_capture_at: null,
    batch: { active: false, processing: false, snapshot_count: 0, max_snapshots: 40 },
};

/** What the reader reports coverage in. Nothing has been seen until it says so,
 *  so a fresh status starts with all four outstanding. */
function unseenFrom(d: Record<string, any>): string[] {
    if (Array.isArray(d.edges_unseen)) return d.edges_unseen.map(String);
    if (Array.isArray(d.edges_seen)) {
        const seen = d.edges_seen.map(String);
        return SHEET_EDGES.filter((e) => !seen.includes(e));
    }
    // A reader too old to report coverage: fall back to the gate it did have,
    // so the glasses say "partial" rather than inventing four unseen edges.
    return d.full_page_seen ? [] : [...SHEET_EDGES];
}

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

// ── which scan the solver works from ────────────────────────────────────────

export interface ActiveAssignment {
    /** Read this for the markdown the run will be built from. */
    source: DocSource;
    /** The pinned attempt number, or null while following the live scan. */
    pinned: number | null;
    /** The reader's count for whichever scan that is — live status or archive. */
    problems: number;
    done: boolean;
}

export function getActiveVersion(): number | null {
    return status.active_version;
}

export interface SetActiveResult {
    ok: boolean;
    reason?: string;
    active_version: number | null;
}

/**
 * Choose the scan the solve button sends. `null` follows the live one.
 *
 * Pinning the *live* entry is stored as null rather than as its number, and the
 * difference matters: the reader is still writing to that attempt, so holding
 * its number would freeze the solver on a snapshot of a scan still being read —
 * and `archivedSource()` would 404 on it, because it isn't a file yet.
 */
export function setActiveVersion(version: number | null): SetActiveResult {
    if (version !== null) {
        const entry = status.versions.find((v) => v.version === version);
        if (!entry) {
            return {
                ok: false,
                reason: `no scan v${version} in the archive`,
                active_version: status.active_version,
            };
        }
        if (!entry.archived) version = null; // the live one: follow it
    }
    if (status.active_version === version) {
        return { ok: true, active_version: version };
    }
    status.active_version = version;
    console.log(
        `[assignment] solver now reads ${version === null ? "the live scan" : `v${version}`}`,
    );
    notifyStatus();
    return { ok: true, active_version: version };
}

/**
 * What the solver should read, resolved.
 *
 * Self-healing: a pin whose scan the reader no longer lists (it was pruned, or
 * the reader was replaced) falls back to live rather than failing every solve
 * from then on. A button that solves the wrong sheet is a bad outcome; a button
 * that has been dead since a scan expired is a worse one.
 */
export function activeAssignment(): ActiveAssignment {
    const live: ActiveAssignment = {
        source: assignmentSource,
        pinned: null,
        problems: status.problems,
        done: status.done,
    };
    const pinned = status.active_version;
    if (pinned === null) return live;

    const entry = status.versions.find((v) => v.version === pinned);
    if (!entry || !entry.archived) {
        console.warn(`[assignment] pinned scan v${pinned} is gone — following live again`);
        status.active_version = null;
        notifyStatus();
        return live;
    }
    return {
        source: archivedSource(pinned),
        pinned,
        problems: entry.problems,
        done: entry.done,
    };
}

// ── the camera itself ───────────────────────────────────────────────────────
//
// The Camera page watches the stream while you aim the paper, so it needs a
// frame rather than a transcription. By default that comes from the reader's
// /snapshot.jpg: it already owns the gateway URL, the snapshot token and the
// RTSP fallback, and putting a second copy of those here would mean two places
// to change when the camera moves. CAMERA_SNAPSHOT_URL points somewhere else
// (the web gateway direct, say) for the case where this server can reach the
// camera stack but the reader is elsewhere.

const SNAPSHOT_URL =
    process.env.CAMERA_SNAPSHOT_URL || (BASE_URL ? `${BASE_URL}/snapshot.jpg` : "");
/** Only for a CAMERA_SNAPSHOT_URL that points at the gateway, which gates on its
 *  own token rather than the reader's. */
const SNAPSHOT_TOKEN = process.env.CAMERA_SNAPSHOT_TOKEN ?? "";
const SNAPSHOT_TIMEOUT_MS = Number(process.env.CAMERA_SNAPSHOT_TIMEOUT_MS ?? 15_000);

export function cameraConfigured(): boolean {
    return SNAPSHOT_URL !== "";
}

/**
 * One JPEG of what the camera sees now.
 *
 * `maxAgeMs` is passed upstream rather than cached here: the reader's cache is
 * the one that stops several viewers spawning several ffmpegs, and duplicating
 * it would only add staleness of our own.
 */
export async function fetchFrame(maxAgeMs: number): Promise<Buffer> {
    if (!cameraConfigured()) throw new Error("no camera snapshot URL configured");
    const url = new URL(SNAPSHOT_URL);
    url.searchParams.set("max_age_ms", String(Math.max(0, Math.round(maxAgeMs))));

    const headers: Record<string, string> = SNAPSHOT_TOKEN
        ? { "x-snapshot-token": SNAPSHOT_TOKEN }
        : authHeaders();

    const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
    });
    if (!res.ok) {
        // Collapsed and short: this ends up in a two-line box on the glasses,
        // where a pretty-printed JSON error body is worse than no detail at all.
        const detail = (await res.text().catch(() => ""))
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120);
        throw new Error(`snapshot HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const jpeg = Buffer.from(await res.arrayBuffer());
    if (!jpeg.length) throw new Error("snapshot was empty");
    return jpeg;
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
            status.problems_complete = Number(d.problems_complete ?? 0);
            status.full_page_seen = Boolean(d.full_page_seen);
            status.edges_unseen = unseenFrom(d);
            status.next_target = String(d.next_target ?? "");
            status.next_target_short = String(d.next_target_short ?? "");
            if (d.batch) status.batch = {
                active: Boolean(d.batch.active),
                processing: Boolean(d.batch.processing),
                snapshot_count: Number(d.batch.snapshot_count ?? 0),
                max_snapshots: Number(d.batch.max_snapshots ?? 40),
            };
            scheduleDocumentRefresh();
            break;

        case "batch_started":
        case "batch_processing":
        case "batch_finished":
        case "batch_failed":
        case "batch_snapshot":
            if (d.batch) status.batch = {
                active: Boolean(d.batch.active),
                processing: Boolean(d.batch.processing),
                snapshot_count: Number(d.batch.snapshot_count ?? status.batch.snapshot_count),
                max_snapshots: Number(d.batch.max_snapshots ?? status.batch.max_snapshots),
            };
            if (event === "batch_snapshot") status.batch.snapshot_count = Number(d.n ?? status.batch.snapshot_count);
            if (event === "batch_processing") status.batch.processing = true;
            if (event === "batch_finished" || event === "batch_failed") status.batch.processing = false;
            notifyStatus();
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
                next_target: String(d.next_target ?? ""),
                next_target_short: String(d.next_target_short ?? ""),
                region: String(d.region ?? ""),
                more_content_beyond: Array.isArray(d.more_content_beyond)
                    ? d.more_content_beyond.map(String)
                    : [],
            };
            if (status.feedback.next_target) {
                status.next_target = status.feedback.next_target;
            }
            if (status.feedback.next_target_short) {
                status.next_target_short = status.feedback.next_target_short;
            }
            status.error = null;
            break;

        case "assignment_updated":
            status.captures = Number(d.capture_count ?? status.captures);
            status.problems = Number(d.problems ?? status.problems);
            status.problems_complete = Number(
                d.problems_complete ?? status.problems_complete,
            );
            status.full_page_seen = Boolean(d.full_page_seen ?? status.full_page_seen);
            // Only when the event carries coverage: this event also fires for a
            // typed assignment and for POST /complete, and defaulting a missing
            // field would walk the count backwards on either.
            if (d.edges_seen || d.edges_unseen) status.edges_unseen = unseenFrom(d);
            if (typeof d.next_target === "string") status.next_target = d.next_target;
            if (typeof d.next_target_short === "string") status.next_target_short = d.next_target_short;
            scheduleDocumentRefresh();
            break;

        case "done":
            status.done = true;
            status.problems = Number(d.problems ?? status.problems);
            status.problems_complete = Number(
                d.problems_complete ?? status.problems,
            );
            // Finished means covered, whether the reader worked that out or the
            // operator said so — and there is nowhere left to point.
            status.edges_unseen = [];
            status.next_target = "";
            status.next_target_short = "";
            status.batch = { active: false, processing: false, snapshot_count: 0, max_snapshots: 40 };
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
            status.problems_complete = 0;
            status.full_page_seen = false;
            status.edges_unseen = [...SHEET_EDGES];
            status.next_target = "";
            status.next_target_short = "";
            status.version = Number(d.version ?? status.version + 1);
            // A new sheet is in front of the camera, so it becomes what the
            // button solves — holding an older pin here would mean photographing
            // a new assignment and having the AI answer the previous one, which
            // nobody would read as correct. Un-pinning rather than pinning the
            // new number: this attempt is live, and live is what null means.
            status.active_version = null;
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

// ── publishing a photo ──────────────────────────────────────────────────────
//
// A sheet you photographed with the phone, read as the assignment instead of
// aiming the camera at it. The reader does the work (POST /photo there); this
// forwards the bytes and keeps the last one so the companion app and the
// glasses can show WHAT was published, which the reader does not expose.

/** What the reader accepts inline — kept in step with GEMINI_IMAGE_TYPES. */
export const PHOTO_TYPES = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
] as const;

export interface PublishedPhoto {
    bytes: Buffer;
    mime: string;
    at: number;
    /** Filename as the phone knew it, when the uploader bothered to say. */
    name: string | null;
}

/**
 * In memory, not on disk. It is a display convenience with a lifetime of "until
 * you publish the next one" — the reader already persists the frame it read as
 * /frame.jpg, which is the copy that matters, and writing a second one here
 * would mean owning its cleanup.
 */
let lastPhoto: PublishedPhoto | null = null;

export function getPublishedPhoto(): PublishedPhoto | null {
    return lastPhoto;
}

export interface PublishResult {
    ok: boolean;
    detail?: string;
    /** The version the reader started for this photo, when it reset. */
    version?: number;
    problems?: number;
    done?: boolean;
}

/**
 * Send a photo upstream to be read into the assignment.
 *
 * `reset` defaults to FALSE, which is the opposite of what it used to be. A
 * photo used to archive the current attempt on the reasoning that a photo is a
 * different sheet — but the ordinary way to read a sheet the camera cannot
 * frame in one shot is several photos OF THE SAME SHEET, and under that default
 * each one threw away the last. So a photo now accumulates exactly as a camera
 * frame does, and `reset: true` is how a caller says "this is a different
 * sheet". The attempt it replaces is archived rather than lost — the reader
 * does that.
 */
export async function publishPhoto(
    photo: Buffer,
    mime: string,
    opts: { reset?: boolean; note?: string; name?: string | null } = {},
): Promise<PublishResult> {
    if (!isConfigured()) return { ok: false, detail: "no reader configured" };

    const query = new URLSearchParams();
    // Sent explicitly in both directions: a reader on the old default would
    // otherwise reset every merge, which is the failure this changed to fix.
    query.set("reset", opts.reset ? "1" : "0");
    if (opts.note) query.set("note", opts.note);
    const suffix = query.toString() ? `?${query}` : "";

    let res: Response;
    try {
        res = await fetch(`${BASE_URL}/photo${suffix}`, {
            method: "POST",
            headers: { ...authHeaders(), "content-type": mime },
            body: new Uint8Array(photo),
            // A photo is one Gemini call on a phone-sized image, so it is slow
            // in a way a control POST never is. The default would give up on a
            // request that was going to succeed.
            signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS),
        });
    } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }

    const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        reset?: { version?: number } | null;
        done?: boolean;
        assignment?: { problems?: unknown[] };
    };

    if (!res.ok || body.ok === false) {
        return { ok: false, detail: body.error ?? `reader HTTP ${res.status}` };
    }

    // Only kept once the reader has accepted it: a photo it refused is not the
    // photo the assignment came from, and showing it as such would be a lie.
    lastPhoto = { bytes: photo, mime, at: Date.now(), name: opts.name ?? null };

    // The reader emits its own events for this, so the status will catch up on
    // its own — but refetching here means the companion app's next poll already
    // shows the new transcription rather than the one it replaced.
    void refreshDocument();
    void refreshArchive();

    return {
        ok: true,
        version: body.reset?.version,
        problems: body.assignment?.problems?.length ?? 0,
        done: Boolean(body.done),
    };
}

/** A phone photo is megabytes and a Gemini read of one is not quick. */
const PHOTO_TIMEOUT_MS = Number(process.env.PHOTO_TIMEOUT_MS ?? 120_000);

/**
 * An assignment you typed, published as a new version.
 *
 * The Adri task (see docs.ts) is not a note beside the assignment — it IS one,
 * just written out rather than photographed. So it goes upstream through the
 * reader like everything else: the previous attempt is archived, the version
 * bumps, and the glasses, the archive and the solve button all treat it exactly
 * as they treat a scan, because there is nothing different about it.
 *
 * No model call and no camera, so this is fast and free — unlike publishPhoto,
 * which is neither.
 */
export async function publishText(markdown: string): Promise<PublishResult> {
    if (!isConfigured()) return { ok: false, detail: "no reader configured" };

    let res: Response;
    try {
        res = await fetch(`${BASE_URL}/assignment`, {
            method: "POST",
            headers: { ...authHeaders(), "content-type": "application/json" },
            body: JSON.stringify({ markdown }),
            signal: AbortSignal.timeout(20_000),
        });
    } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }

    const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        version?: number;
        problems?: number;
    };
    if (!res.ok || body.ok === false) {
        return { ok: false, detail: body.error ?? `reader HTTP ${res.status}` };
    }

    void refreshDocument();
    void refreshArchive();
    return { ok: true, version: body.version, problems: body.problems ?? 0, done: true };
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
 *   complete "that's all of it" — mark what has been read as final, no capture
 *   batch_*  manual snapshot mode: start it, store the current frame, then send
 *            every stored frame to the model as one reading
 *   none     deliberately nothing; what a tap resolves to when the only thing
 *            left to do would destroy the transcription (see defaultAction)
 *   toggle   whichever of the above fits the current state (the tap gesture)
 *
 * A runtime list, not a bare type: the HTTP route has to check what the glasses
 * asked for against something, and a second hand-written copy of this union
 * only has to be forgotten once for a whole feature to answer "unknown action".
 */
export const CONTROL_ACTIONS = [
    "start",
    "stop",
    "reset",
    "restart",
    "extend",
    "complete",
    "batch_start",
    "batch_snapshot",
    "batch_finish",
    "none",
    "toggle",
] as const;

export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export interface ControlResult {
    ok: boolean;
    /** What we actually did, so the caller can label its button. */
    action:
        | "started"
        | "stopped"
        | "reset"
        | "restarted"
        | "extended"
        | "completed"
        | "batch_started"
        | "snapshot_taken"
        | "batch_processing"
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

            // The operator overruling the coverage gate. Worth having on the
            // glasses because they are where you find out it is stuck: the
            // transcription reads complete, the footer still says an edge is
            // unseen, and the person wearing them can see the paper ends there.
            case "complete": {
                const err = await call("/complete");
                if (err) return fail(err);
                status.running = false;
                status.done = true;
                status.edges_unseen = [];
                status.next_target = "";
                notifyStatus();
                return { ok: true, action: "completed" };
            }

            case "batch_start": {
                const err = await call("/batch/start", { max_snapshots: 40 });
                if (err) return fail(err);
                status.batch = { active: true, processing: false, snapshot_count: 0, max_snapshots: 40 };
                notifyStatus();
                return { ok: true, action: "batch_started" };
            }

            case "batch_snapshot": {
                const err = await call("/batch/snapshot");
                if (err) return fail(err);
                status.batch.snapshot_count += 1;
                notifyStatus();
                return { ok: true, action: "snapshot_taken" };
            }

            case "batch_finish": {
                const err = await call("/batch/finish");
                if (err) return fail(err);
                status.batch.active = false;
                status.batch.processing = true;
                notifyStatus();
                return { ok: true, action: "batch_processing" };
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
