// The Camera page: what the camera sees, refreshed while you aim the paper,
// plus every control that starts and stops a scan.
//
// WHY THIS PAGE EXISTS. The reader's advice ("Move camera DOWN", "Cut off:
// bottom") is the model's read on framing, and it is expressed in the CAMERA's
// frame of reference. That cannot describe a camera which is simply rotated —
// with the lens rolled 90°, "move up" moves you sideways, and no amount of
// prompt work fixes it, because the model has no idea how the camera sits
// relative to your hands. A picture answers it at a glance. It also costs
// nothing but a frame grab: the preview never spends a Gemini call.
//
// The advice is kept, not replaced. The two say different things — the picture
// says where the paper is, the advice says what the reader still needs (blur,
// glare, which edge is missing) — and they are both in front of you here.
//
// WHAT MOVED. Start / stop / resume / rescan / clear used to be on the
// Assignment page. Aiming and reading are different jobs: a tap meant to turn a
// page should not be able to start a job, and a page you read from should not
// be repainting a camera at it. So the controls live here, next to the picture
// of what they are about, and the Assignment page is now purely a reader.
//
// They live in the MENU here, not on the tap. The same argument that moved them
// off the Assignment page applies to the gesture: a temple tap is the easiest
// thing on these glasses to do by accident, and while a scan is running the
// thing it did was stop it — losing the page you were holding steady. Tap now
// only dismisses an error; every control is one double-tap away.
//
// PACING. The preview is the most expensive thing this app draws — a camera
// frame does not palette-compress the way black-background text does, so a full
// panel of it is ~30KB against ~7KB for a page of transcription. Rather than
// picking an interval and hoping, each frame is scheduled off what the last one
// actually cost over BLE (see nextDelay): a good link gets a picture every
// couple of seconds, a poor one slows down instead of queueing up behind
// itself, and the "Small preview" menu entry drops to a single ~8KB tile.

import {
    DOC_BASE_ASSIGNMENT,
    DOC_FEEDBACK_ID,
    DOC_FEEDBACK_LARGE_ID,
    DOC_MENU_ID,
    DOC_PAGER_ID,
    GESTURE_EVENTS,
    HUD_FEEDBACK_RECT,
    HUD_FEEDBACK_LARGE_RECT,
    MARKDOWN_SERVER_URL,
    POLL_INTERVAL_MS,
    Z_FEEDBACK,
    Z_FEEDBACK_LARGE,
} from "./constants";
import { GlobalState, type AssignmentStatus } from "./state";
import { createMenu, type MenuEntry } from "./menu";
import { createPanel } from "./panel";
import { bridge, navigateBack } from "./main";
import { appLog } from "./debug";
import { createTilePusher } from "./render/tilePush";
import { base64ToBytes } from "./render/tiles";
import { TextContainerUpgrade } from "@evenrealities/even_hub_sdk";

/** Named actions the document server accepts (see server/assignment.ts). */
type ControlAction =
    | "start" | "stop" | "reset" | "restart" | "extend" | "complete"
    | "batch_start" | "batch_snapshot" | "batch_finish";

/** How the server draws a frame for the panel — see server/render/camera.ts. */
type PreviewMode = "ink" | "photo";

interface PreviewTile {
    index: number;
    data: string;
}

interface PreviewResponse {
    tiles: PreviewTile[];
    size: number;
    rotate: number;
    mode: PreviewMode;
    /** Ink amplitude the frame actually had, 0-255. `null` in photo mode. */
    contrast: number | null;
}

// ── pacing ──────────────────────────────────────────────────────────────────

/**
 * How long to wait after a frame lands before asking for the next one.
 *
 * Half of what the last push cost, so the link is left roughly a third idle for
 * the things that must stay responsive — the advice box and the footer are text
 * upgrades queued behind the tiles, and a preview that saturated the link would
 * make the whole page feel dead. Clamped at both ends: never hammer a fast link,
 * never wait so long on a slow one that the picture stops being about now.
 */
const MIN_GAP_MS = 750;
const MAX_GAP_MS = 3_000;

function nextDelay(lastPushMs: number): number {
    if (!lastPushMs) return MIN_GAP_MS;
    return Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, Math.round(lastPushMs / 2)));
}

// ── page state ──────────────────────────────────────────────────────────────

let active = false;
let previewTimer: ReturnType<typeof setTimeout> | null = null;
let eventSource: EventSource | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

/** Frames landed this visit, and when the last one did — the page's own pulse. */
let frames = 0;
let lastFrameAt = 0;
let previewError: string | null = null;

/** Turned in the menu or with a swipe. The one thing the advice cannot say. */
let rotation = 0;
/** 4 tiles (the whole panel) or 1 (a corner), when the link can't feed the big one. */
let previewSize: 1 | 4 = 4;

/**
 * Marks on black (the default) or the photograph. The server does the work; see
 * the note at the top of server/render/camera.ts for why ink is the default.
 * Photo is here for the frame that isn't about a page — finding the desk in a
 * dark room, checking whether a hand is in shot — which ink discards.
 */
let mode: PreviewMode = "ink";

/**
 * Ink amplitude in the last frame, as the server measured it, or null in photo
 * mode. An ink render of a frame with nothing readable in it is BLACK, and a
 * preview that has stopped arriving is also black; this is what separates them
 * in the footer.
 */
let contrast: number | null = null;

/**
 * Below this the server stopped scaling the frame up (INK_MIN_SPAN in
 * server/render/camera.ts), which is to say the panel is dark because the frame
 * had nothing in it — not because the preview is broken.
 */
const LOW_INK = 16;

// A control takes a round trip to the reader; ignore gestures until it lands so
// an impatient double-press can't start and immediately stop a job.
let controlInFlight = false;
let working: string | null = null;
let controlError: string | null = null;

const tiles = createTilePusher("Camera");

// All bridge writes run through one chain: updateImageRawData must be strictly
// serial, and the preview, the advice box, the footer and the menu all write.
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T | void> {
    chain = chain.then(task).catch((err) => appLog("Camera", "task failed", err));
    return chain as Promise<T | void>;
}

function status(): AssignmentStatus | null {
    return GlobalState.assignmentStatus;
}

// ── text ────────────────────────────────────────────────────────────────────

const ADVICE_COLS = 20;
const FOOTER_COLS = 40;

function clip(text: string, cols: number): string {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length <= cols ? line : `${line.slice(0, cols - 1)}…`;
}

function fitBox(lines: string[], rows = 2, cols = ADVICE_COLS): string {
    return lines
        .filter((l) => l !== "")
        .slice(0, rows)
        .map((l) => clip(l, cols))
        .join("\n");
}

/**
 * A sentence across the whole box instead of one clipped line.
 *
 * `next_target` names the part of the sheet the reader still wants, and twenty
 * characters of it is usually just the verb. When there is no direction to put
 * on line one — the framing is fine and what's left is knowing where to go —
 * the destination gets both rows and breaks on words.
 */
function wrapBox(text: string, rows = 2, cols = ADVICE_COLS): string {
    const words = text.replace(/\s+/g, " ").trim().split(" ");
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (candidate.length <= cols) {
            line = candidate;
            continue;
        }
        if (line) lines.push(line);
        if (lines.length === rows) break;
        line = word;
    }
    if (line && lines.length < rows) lines.push(line);
    return fitBox(lines, rows, cols);
}

/**
 * The camera instruction, from the model's ENUM rather than its prose —
 * `advice_detail` is a whole sentence into a box that holds about 40
 * characters, and it arrives in English whatever the paper's language.
 */
const ADVICE: Record<string, string> = {
    ok: "Framing OK",
    move_up: "Move camera UP",
    move_down: "Move camera DOWN",
    move_left: "Move camera LEFT",
    move_right: "Move camera RIGHT",
    move_closer: "Move CLOSER",
    move_farther: "Move BACK",
    move_slightly_up: "Nudge UP",
    move_slightly_down: "Nudge DOWN",
    move_slightly_left: "Nudge LEFT",
    move_slightly_right: "Nudge RIGHT",
    refocus: "Refocus - blurry",
    reduce_glare: "Glare - shade it",
    reposition_paper: "Straighten paper",
};

/**
 * Which edges of the paper still have to be shown to the camera, in a few
 * words. Empty once the sheet has been covered — over as many partial frames
 * as it took, which is the only way it happens at a readable distance.
 */
function needLabel(s: AssignmentStatus): string {
    const unseen = s.edges_unseen ?? [];
    if (!unseen.length) return "";
    return `Still need: ${unseen.join(", ")}`;
}

/** "12s" / "3m 04s" — how long since something last happened. */
function elapsed(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    if (total < 60) return `${total}s`;
    return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

/**
 * The corner box: what to do with the CAMERA. It sits over the bottom-right
 * tile and its dark background is baked into the preview by the server, exactly
 * as it is into the assignment's tiles.
 */
function feedbackText(): string {
    if (controlError) return fitBox([controlError, "Tap to dismiss"]);
    if (working) return fitBox([`${working}...`]);

    const s = status();
    if (!s) return "Connecting...";
    if (s.upstream === "disabled") return "No reader configured";
    if (s.upstream !== "open") return fitBox([`Reader ${s.upstream}`, s.error ?? ""]);

    if (s.batch?.active)
        return fitBox([`Snapshots: ${s.batch.snapshot_count}`, "Tap=snap 2x=menu"]);
    if (s.batch?.processing)
        return fitBox([`Reading ${s.batch.snapshot_count} images`, "Please wait"]);

    if (s.running) {
        const f = s.feedback;
        if (!f) return fitBox([`Capture ${s.captures}...`, "2x = menu"]);
        // The sheet is read a piece at a time, so the question this box answers
        // is "where do I point next", not "is the whole page in shot". When the
        // model gives a direction that leads, because it is the thing you act
        // on, and the destination follows it. When it doesn't, the destination
        // takes both lines rather than being clipped to a verb.
        // The reader supplies a <=20 character target specifically for this
        // two-line HUD. Keep the full target in the API, but never put the
        // long prose version in the box where it gets clipped mid-instruction.
        const target = f.next_target_short || f.next_target;
        if (f.camera_advice && f.camera_advice !== "ok") {
            const why =
                target ||
                (f.cut_off_edges.length
                    ? `Cut off: ${f.cut_off_edges.join(", ")}`
                    : f.frame_quality && f.frame_quality !== "good"
                      ? `Frame: ${f.frame_quality}`
                      : "Hold still");
            return fitBox([ADVICE[f.camera_advice] ?? "Adjust the camera", why]);
        }
        if (target) return wrapBox(target);
        if (f.frame_quality && f.frame_quality !== "good") {
            return fitBox(["Framing OK", `Frame: ${f.frame_quality}`]);
        }
        return fitBox([needLabel(s) || "Framing OK", "Hold still"]);
    }

    // Nothing is running: the box says what the scan is and where the controls
    // are. It names the MENU rather than a tap — every scan action moved there
    // when a stray tap turned out to be able to stop a reading mid-page.
    if (s.done) return fitBox([`Done - ${s.problems} problems`, "2x = menu"]);
    if (s.error) return fitBox([`Failed: ${s.error}`, "2x = menu"]);
    // A scan that ran out of budget almost always did so one edge short — say
    // which, because that is the difference between "point it lower and resume"
    // and "the paper ends there, mark it read" (both are in the menu).
    if (s.reason === "max_captures")
        return fitBox(["Hit capture limit", needLabel(s) || "2x = menu"]);
    if (s.captures > 0)
        return fitBox([`Stopped at ${s.captures}`, needLabel(s) || "2x = menu"]);
    return fitBox(["Nothing read yet", "2x = menu to start"]);
}

/**
 * The footer: whether the PREVIEW is alive, and whether the JOB is.
 *
 * The preview's own health leads. It is the reason to be on this page, it is
 * the thing most likely to be quietly broken (the stream stops publishing and
 * the last frame simply sits there looking plausible), and a still picture
 * gives no clue on its own that it has stopped being about now.
 */
function pagerLabel(): string {
    const selection = menu.line();
    if (selection) return selection;

    const parts: string[] = [];

    if (previewError) parts.push(`Preview: ${previewError}`);
    else if (!frames) parts.push("Preview starting...");
    else parts.push(`Live ${elapsed(Date.now() - lastFrameAt)} ago`);

    // Said before the job's state, and in place of nothing else, because a dark
    // panel is the one thing on this page that reads as a fault when it isn't:
    // the frame arrived and there was nothing in it to draw.
    if (contrast !== null && contrast < LOW_INK && !previewError) parts.push("no detail");

    if (rotation) parts.push(`rot ${rotation}`);
    if (mode === "photo") parts.push("photo");

    const s = status();
    if (s) {
        if (s.running) {
            const since =
                s.last_capture_at === null
                    ? "starting"
                    : `${elapsed(Date.now() - s.last_capture_at)} ago`;
            parts.push(`c${s.captures} ${since}`);
        } else if (s.done) parts.push("done");
        else if (s.captures > 0) parts.push(`stopped c${s.captures}`);
    }

    return clip(parts.join("  -  "), FOOTER_COLS);
}

// ── the preview loop ────────────────────────────────────────────────────────

function previewQuery(): string {
    const parts = [`size=${previewSize}`, `rotate=${rotation}`, `mode=${mode}`];
    // While the menu is up the same frame is rendered with the menu's rectangle
    // reserved, so the panel has something dark to sit on and the camera stays
    // visible around it. Cheaper than a separate backdrop, and far more useful:
    // "Stop" is a decision about what you are looking at.
    if (menu.isOpen()) parts.push("overlay=menu");
    return `?${parts.join("&")}`;
}

async function fetchPreview(): Promise<PreviewTile[]> {
    const res = await fetch(
        `${MARKDOWN_SERVER_URL}${DOC_BASE_ASSIGNMENT}/camera${previewQuery()}`,
    );
    if (!res.ok) {
        // The reader says why in `detail` — "stream not publishing" is a
        // different problem from "no camera configured", and both are things to
        // read on the glasses rather than in a log nobody has open.
        const body = (await res.json().catch(() => ({}))) as { detail?: string };
        throw new Error(body.detail ? clip(body.detail, 30) : `HTTP ${res.status}`);
    }
    const preview = (await res.json()) as PreviewResponse;
    contrast = preview.contrast;
    return preview.tiles;
}

/** One frame: fetch, push, then schedule the next off what the push cost. */
async function previewTick(): Promise<void> {
    if (!active) return;
    // The menu owns all four image tiles while open. Do not let a queued camera
    // preview put the live frame back underneath it.
    if (menu.isOpen()) return;

    try {
        const frame = await fetchPreview();
        if (!active) return;
        await enqueue(async () => {
            if (menu.isOpen()) return;
            tiles.beginBatch("preview");
            for (const tile of frame) {
                await tiles.push(tile.index, base64ToBytes(tile.data));
            }
            tiles.endBatch(frame.length);
        });
        frames += 1;
        lastFrameAt = Date.now();
        previewError = null;
    } catch (err) {
        // Keep the last frame on screen: a stale picture with the footer saying
        // so is more use than a black panel, and the stream usually comes back.
        previewError = err instanceof Error ? clip(err.message, 24) : "failed";
        appLog("Camera", "preview failed", err);
    }

    repaint();
    schedulePreview(nextDelay(tiles.lastBatchMs()));
}

function schedulePreview(delayMs: number): void {
    if (previewTimer) clearTimeout(previewTimer);
    if (!active) return;
    previewTimer = setTimeout(() => {
        previewTimer = null;
        void previewTick();
    }, delayMs);
}

// ── status feed ─────────────────────────────────────────────────────────────
//
// The reader's status arrives on the assignment document's stream, which also
// carries the transcription this page never draws. Reusing it keeps one SSE
// shape on the server and one connection per client — the markdown frames cost
// wifi, not BLE, and this page holds the stream only while you are on it.

function applyStatus(data: unknown): void {
    GlobalState.assignmentStatus = data as AssignmentStatus;
    syncTicker();
    repaint();
}

function openStream(): void {
    closeStream();
    try {
        const source = new EventSource(
            `${MARKDOWN_SERVER_URL}${DOC_BASE_ASSIGNMENT}/events`,
        );
        source.addEventListener("status", (e) => {
            try {
                applyStatus(JSON.parse((e as MessageEvent).data));
            } catch (err) {
                appLog("Camera", "bad status payload", err);
            }
        });
        source.onerror = () => {
            // EventSource reconnects on its own; the poll below covers the gap
            // so the advice can't freeze on whatever it last said.
            appLog("Camera", "status stream error");
        };
        eventSource = source;
    } catch (err) {
        appLog("Camera", "status stream failed", err);
    }

    if (!pollTimer) {
        pollTimer = setInterval(() => void pollStatus(), POLL_INTERVAL_MS);
    }
}

async function pollStatus(): Promise<void> {
    if (!active) return;
    try {
        const res = await fetch(`${MARKDOWN_SERVER_URL}${DOC_BASE_ASSIGNMENT}/status`);
        if (res.ok) applyStatus(await res.json());
    } catch {
        // The preview's own error line already says the server is unreachable.
    }
}

function closeStream(): void {
    eventSource?.close();
    eventSource = null;
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

// ── painting ────────────────────────────────────────────────────────────────

const advice = createPanel({
    containerID: DOC_FEEDBACK_ID,
    name: "feedback",
    rect: HUD_FEEDBACK_RECT,
    zOrderIndex: Z_FEEDBACK,
    enqueue,
});
const largeAdvice = createPanel({
    containerID: DOC_FEEDBACK_LARGE_ID,
    name: "feedbackLarge",
    rect: HUD_FEEDBACK_LARGE_RECT,
    zOrderIndex: Z_FEEDBACK_LARGE,
    enqueue,
});

let shownPager: string | null = null;

async function updatePager(): Promise<void> {
    const content = pagerLabel();
    if (content === shownPager) return;
    shownPager = content;
    await bridge.textContainerUpgrade(
        new TextContainerUpgrade({
            containerID: DOC_PAGER_ID,
            containerName: "pager",
            content,
        }),
    );
}

function repaint(): void {
    const text = feedbackText();
    if (previewSize === 1) {
        advice.clear();
        largeAdvice.set(text);
    } else {
        largeAdvice.clear();
        advice.set(text);
    }
    void enqueue(updatePager);
}

/** Tick once a second so "12s ago" actually moves while you watch it. */
function syncTicker(): void {
    const moving = active && (Boolean(status()?.running) || frames > 0);
    if (moving && !ticker) ticker = setInterval(repaint, 1_000);
    else if (!moving && ticker) {
        clearInterval(ticker);
        ticker = null;
    }
}

// ── the action menu ─────────────────────────────────────────────────────────

const control = (label: string, action: ControlAction): MenuEntry => ({
    label,
    run: () => void send("/control", { action }, label),
});

function buildMenu(): MenuEntry[] {
    const s = status();
    const captures = s?.captures ?? 0;
    // Back leads, so the destructive entries are somewhere you travel to rather
    // than somewhere you land — and double-tap-tap still means "leave", which is
    // what it meant before the menu took the gesture.
    const items: MenuEntry[] = [{ label: "Back", run: leavePage }];

    if (s?.batch?.active) {
        items.push(control(`Take snapshot ${s.batch.snapshot_count + 1}`, "batch_snapshot"));
        if (s.batch.snapshot_count > 0) items.push(control("Send batch to AI", "batch_finish"));
        items.push({ label: "Close", run: () => {} });
        return items;
    }
    if (s?.batch?.processing) {
        items.push({ label: `Reading ${s.batch.snapshot_count} snapshots`, run: () => {} });
        items.push({ label: "Close", run: () => {} });
        return items;
    }
    items.push(control("Batch snapshots", "batch_start"));

    if (s?.running) {
        items.push(control("Stop", "stop"));
        items.push(control("Rescan from scratch", "restart"));
    } else if (s?.done) {
        items.push(control("Rescan from scratch", "restart"));
    } else if (s?.reason === "max_captures") {
        // /start alone would end on the same ceiling check it ended on last
        // time, so the two real choices are more budget or a clean sheet.
        items.push(control("Raise limit", "extend"));
        items.push(control("Rescan from scratch", "restart"));
    } else if (captures > 0) {
        items.push(control(`Resume from ${captures}`, "start"));
        items.push(control("Rescan from scratch", "restart"));
    } else {
        items.push(control("Start reading", "start"));
    }

    // "That's all of it" — the way out when the reader is waiting for an edge
    // of the paper that will never come (a sheet cut short, an edge it won't
    // call an edge). You are the one looking at the paper; this believes you.
    // Offered only when there is something to finish and it isn't finished.
    if (captures > 0 && !s?.done && !s?.running) {
        items.push(control("That's all of it", "complete"));
    }

    if (captures > 0) items.push(control("Clear", "reset"));

    items.push({ label: `Rotate view (${rotation})`, run: () => turn(90) });
    // Labelled with what it switches TO, like the size entry below it.
    items.push({
        label: mode === "ink" ? "Photo view" : "Ink view",
        run: () => {
            mode = mode === "ink" ? "photo" : "ink";
            // The two modes share no pixels — every container is about to hold
            // a completely different picture, and the dedup cache would happily
            // decide a tile hadn't changed enough to resend.
            tiles.reset();
            contrast = null;
            schedulePreview(0);
        },
    });
    items.push({
        label: previewSize === 4 ? "Small preview" : "Big preview",
        run: () => {
            previewSize = previewSize === 4 ? 1 : 4;
            // The containers the small preview stops writing to would otherwise
            // keep the big one's last frame in their corners.
            tiles.reset();
            schedulePreview(0);
        },
    });
    items.push({ label: "Close", run: () => {} });
    return items;
}

function menuHeading(): string {
    if (controlError) return "THAT DIDN'T WORK";
    const s = status();
    if (!s) return "CONNECTING";
    if (s.upstream !== "open") return `READER ${s.upstream.toUpperCase()}`;
    if (s.batch?.active) return `BATCH - ${s.batch.snapshot_count} snapshots`;
    if (s.batch?.processing) return `READING ${s.batch.snapshot_count} snapshots`;
    if (s.running) return `RUNNING - capture ${s.captures}`;
    if (s.done) return `DONE - ${s.problems} problems`;
    if (s.reason === "max_captures") return `LIMIT REACHED - ${s.captures} captures`;
    if (s.captures > 0) return `STOPPED - ${s.captures} captures`;
    return "IDLE - nothing read yet";
}

const menu = createMenu({
    name: "Camera",
    containerID: DOC_MENU_ID,
    build: buildMenu,
    heading: menuHeading,
    enqueue,
    onPaint: async () => {
        await updatePager();
    },
    // Replace all four camera tiles with the shared black menu backdrop. The
    // menu remains readable even if the preview was stale or a frame lands late.
    backdrop: {
        show: async (tilesForBackdrop) => {
            tiles.beginBatch("camera menu backdrop");
            for (let index = 0; index < tilesForBackdrop.length; index++) {
                await tiles.push(index, tilesForBackdrop[index]!);
            }
            tiles.endBatch(tilesForBackdrop.length);
        },
        hide: () => {
            tiles.reset();
            schedulePreview(0);
            return Promise.resolve();
        },
    },
});

// ── controls ────────────────────────────────────────────────────────────────

/** Turn the preview, and ask for a frame at the new angle straight away. */
function turn(degrees: number): void {
    rotation = (rotation + degrees + 360) % 360;
    // Every container is about to hold a differently-shaped picture; without
    // this the dedup cache can leave a tile from the old orientation in place.
    tiles.reset();
    schedulePreview(0);
    repaint();
}

async function send(path: string, body: unknown, label: string): Promise<void> {
    if (controlInFlight) return;
    controlInFlight = true;
    controlError = null;
    // Set before the request leaves: a control is two servers and a camera
    // away, and without this the tap reads as ignored for the whole round trip.
    working = label;
    repaint();
    try {
        const res = await fetch(`${MARKDOWN_SERVER_URL}${DOC_BASE_ASSIGNMENT}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const result = (await res.json()) as { ok: boolean; action: string; detail?: string };
        appLog("Camera", path, result.action, result.detail ?? "");
        if (!result.ok) {
            // Kept until you act on it: the reader never emits an event for a
            // refusal, so nothing else will ever repaint this away.
            controlError = `Couldn't ${label.toLowerCase()}: ${result.detail ?? "refused"}`;
        }
    } catch (err) {
        appLog("Camera", path, "failed", err);
        controlError = "The document server is unreachable";
    } finally {
        controlInFlight = false;
        working = null;
        repaint();
    }
}

function leavePage(): void {
    leaveCameraPage();
    navigateBack();
}

// ── lifecycle ───────────────────────────────────────────────────────────────

/** Called by main.ts once the camera page's containers are built. */
export async function enterCameraPage(): Promise<void> {
    active = true;
    frames = 0;
    lastFrameAt = 0;
    previewError = null;
    contrast = null;
    working = null;
    controlError = null;
    shownPager = null;
    // The containers are brand new and blank: both caches would otherwise dedup
    // against what the last visit left on screen and write nothing.
    tiles.reset();
    advice.reset();
    largeAdvice.reset();

    openStream();
    void pollStatus();
    syncTicker();
    repaint();
    schedulePreview(0);
}

export function leaveCameraPage(): void {
    active = false;
    if (previewTimer) {
        clearTimeout(previewTimer);
        previewTimer = null;
    }
    if (ticker) {
        clearInterval(ticker);
        ticker = null;
    }
    closeStream();
    menu.close(false); // no repaint: these containers are about to go
}

export function handleCameraPageEvent(gesture: GESTURE_EVENTS): void {
    if (menu.handleGesture(gesture)) return;

    if (gesture === GESTURE_EVENTS.DOUBLE_TAP) {
        // Not while a control is in flight: the entries are built from job
        // state that is about to change.
        if (!controlInFlight) menu.open();
        return;
    }

    // Nothing on this page pages, so the swipes are free — and rotation is the
    // thing you come here to fix. Up and down turn opposite ways so overshooting
    // is one gesture back, not three.
    if (gesture === GESTURE_EVENTS.SWIPE_UP) return turn(-90);
    if (gesture === GESTURE_EVENTS.SWIPE_DOWN) return turn(90);

    if (gesture === GESTURE_EVENTS.TAP) {
        // Manual batch mode is deliberately the one exception to the
        // "tap does nothing" rule: after starting a batch, each tap stores the
        // current camera frame. The menu remains available via double-tap for
        // sending or cancelling the batch.
        if (status()?.batch?.active && !controlError) {
            void send("/control", { action: "batch_snapshot" }, "take snapshot");
            return;
        }
        // A tap acknowledges the error it is retrying past, and does nothing
        // else. It used to toggle the scan, which meant a stray tap while you
        // were holding the paper steady stopped the reading mid-page — the one
        // action on this page you would never choose at that moment. Every scan
        // control is a double-tap away in the menu (buildMenu), where choosing
        // one is deliberate, so nothing was lost by taking it off the gesture
        // that is easiest to make by accident.
        if (controlError) {
            controlError = null;
            repaint();
        }
    }
}
