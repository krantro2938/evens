// The Assignment page: whatever the lookcam reader has transcribed off the
// paper so far, re-rendered as it fills in, plus a corner box that carries the
// model's camera advice and doubles as the control surface.
//
// Same document machinery as the AI page (docPage.ts); the differences are the
// endpoint, a `status` SSE listener, and the gestures:
//
//   tap         do the obvious thing — start, stop, or rescan (server decides)
//   swipe       page through the document
//   double tap  open the action menu (swipe to choose, tap to confirm)
//
// The menu exists because the obvious thing isn't always what you want: a
// half-read assignment can be resumed OR scrapped and rescanned, and only you
// know which. It takes over double-tap — leaving the page becomes its "Back"
// entry — because tap and the swipes are all spoken for, and the SDK has no
// long-press. It draws as a centred panel listing every action, mirrored one
// line at a time in the footer so it survives being hidden behind the tiles.

import {
    DOC_BASE_ASSIGNMENT,
    DOC_FEEDBACK_ID,
    DOC_MENU_ID,
    GESTURE_EVENTS,
    HUD_FEEDBACK_RECT,
    MARKDOWN_SERVER_URL,
    Z_FEEDBACK,
} from "./constants";
import { GlobalState, type AssignmentStatus, type DocState } from "./state";
import { createDocPage } from "./docPage";
import { createMenu, type MenuEntry } from "./menu";
import { createPanel } from "./panel";
import { navigateBack } from "./main";
import { appLog } from "./debug";

/** Named actions the document server accepts (see server/assignment.ts). */
type ControlAction = "start" | "stop" | "reset" | "restart" | "extend";

// A control takes a round trip to the reader; ignore gestures until it lands so
// an impatient double-press can't start and immediately stop a job.
let controlInFlight = false;

function status(): AssignmentStatus | null {
    return GlobalState.assignmentStatus;
}

/**
 * The footer line: where we are in the document, or the current menu selection
 * while a menu is open.
 *
 * It mirrors the centred panel deliberately. The footer starts at PAGE_H —
 * exactly where the image tiles stop — so it is the one strip nothing can be
 * drawn over, and it keeps the menu usable even if the panel is hidden.
 */
function pagerLabel(state: DocState): string {
    const selection = menu.line();
    if (selection) return selection;
    // See the AI page: a blank panel with a healthy pager is a link failure, not
    // a document that failed to render.
    if (state.linkError) return "Glasses link error - tiles not sent";
    const s = status();
    if (s && s.upstream !== "open") return `Reader ${s.upstream}`;
    if (!state.pages.length) return s?.running ? "Reading the page..." : state.status;
    const pages = `${state.currentPage + 1} / ${state.pages.length}`;
    return s?.running ? `${pages}  -  capture ${s.captures}` : pages;
}

/**
 * The corner box. It is always on screen — border width is part of the page
 * definition and can't be upgraded, so a box that appeared and disappeared
 * would need a full page rebuild (and a re-push of all four tiles) every time
 * a job started. Instead it always shows the most useful thing available:
 * camera advice while capturing, otherwise what a tap will do.
 */
function feedbackText(): string {
    const s = status();
    if (!s) return "Connecting...";
    if (s.upstream === "disabled") return "No reader configured";
    if (s.upstream !== "open") return `Reader ${s.upstream}\n${s.error ?? ""}`.trim();

    if (s.running) {
        const f = s.feedback;
        if (!f) return `Capture ${s.captures}...\nTap to stop`;
        // advice_detail is a full sentence; camera_advice is the enum. Lead with
        // the enum so the useful word survives even if the box clips.
        const head = f.camera_advice && f.camera_advice !== "ok" ? `! ${f.camera_advice}` : "OK framing";
        return `${head}\n${f.advice_detail}`;
    }

    if (s.done) return `Done - ${s.problems} problems\nTap to rescan`;
    if (s.error) return `Failed: ${s.error}\nTap to retry`;
    if (s.reason === "max_captures") return "Hit capture limit\nTap to rescan - 2x = menu";
    if (s.reason === "stopped") return `Stopped at ${s.captures}\nTap to resume - 2x = menu`;
    return "Tap to start reading";
}

// ── the action menu ─────────────────────────────────────────────────────────

const control = (label: string, action: ControlAction): MenuEntry => ({
    label,
    run: () => send("/control", { action }, label),
});

/**
 * What's worth offering here, most likely first — ordering matters more than
 * usual, because the first entry is what a tap-tap does. Rebuilt on every open,
 * so it always reflects where the job actually is.
 */
function buildMenu(): MenuEntry[] {
    const s = status();
    const captures = s?.captures ?? 0;
    // Back leads. It is what double-tap did before the menu took that gesture,
    // so double-tap-tap still means "leave" and the old reflex keeps working.
    // It also makes the destructive entries something you travel to rather than
    // something you land on.
    const items: MenuEntry[] = [{ label: "Back", run: leavePage }];

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

    // Archive without spending a capture — for when you're done with the paper
    // but not ready to point the camera at the next one.
    if (captures > 0) items.push(control("Clear", "reset"));

    // Dismiss: createMenu closes before it runs an entry, so by this point
    // there is nothing left to do.
    items.push({ label: "Close", run: () => {} });
    return items;
}

/**
 * The panel's first line. It says what the job is doing, because which entries
 * exist depends entirely on that — "Stop" is only offered while something is
 * running, and without this the menu gives no hint as to why it's missing.
 */
function menuHeading(): string {
    const s = status();
    if (!s) return "CONNECTING";
    if (s.upstream !== "open") return `READER ${s.upstream.toUpperCase()}`;
    if (s.running) return `RUNNING - capture ${s.captures}`;
    if (s.done) return `DONE - ${s.problems} problems`;
    if (s.reason === "max_captures") return `LIMIT REACHED - ${s.captures} captures`;
    if (s.captures > 0) return `STOPPED - ${s.captures} captures`;
    return "IDLE - nothing read yet";
}

const menu = createMenu({
    name: "Assignment",
    containerID: DOC_MENU_ID,
    build: buildMenu,
    heading: menuHeading,
    // Menu paints join the page's chain, so they can't interleave with a tile
    // push that happens to land mid-swipe.
    enqueue: (task) => page.enqueue(task),
    // The footer mirrors the selection; repainting it is the pager's own job.
    onPaint: () => page.updatePager(),
    // The document lives in the image tiles, and a text container is
    // transparent — so the menu swaps the tiles for its own dark backdrop
    // while it's up, and the page puts the document back afterwards.
    backdrop: {
        show: (tiles) => page.overlayTiles(tiles),
        hide: () => page.restoreTiles(),
    },
});

// The camera-advice panel. Its dark background and frame come baked into the
// assignment's tiles (the server reserves this rect) — see panel.ts.
const advice = createPanel({
    containerID: DOC_FEEDBACK_ID,
    name: "feedback",
    rect: HUD_FEEDBACK_RECT,
    zOrderIndex: Z_FEEDBACK,
    enqueue: (task) => page.enqueue(task),
});

// ── page ────────────────────────────────────────────────────────────────────

const page = createDocPage({
    name: "Assignment",
    base: DOC_BASE_ASSIGNMENT,
    state: GlobalState.assignmentState,
    // Swipes page through the document; tap is the start/stop button.
    tapAction: "action",
    onPrimaryAction: () => void send("/toggle", undefined, "Working"),
    pagerLabel,
    events: {
        status: (data) => {
            GlobalState.assignmentStatus = data as AssignmentStatus;
            // Status moves far more often than the document does, so this only
            // touches the two text containers — never the image tiles.
            updateFeedback();
            page.enqueue(() => page.updatePager());
        },
    },
    // Tiles land on their own schedule; keep the box in step with them.
    afterShow: async () => updateFeedback(),
});

/**
 * Repaint the corner box. It keeps showing camera advice while the menu is
 * open — the menu is in the footer, so choosing "Stop" doesn't cost you sight
 * of the reason you're stopping.
 */
function updateFeedback(): void {
    advice.set(feedbackText());
}

/**
 * Ask the document server to act. `/toggle` lets it pick from live job state
 * (see server/assignment.ts); `/control` names the action outright, which is
 * what the menu is for.
 */
async function send(path: string, body: unknown, working: string): Promise<void> {
    if (controlInFlight) return;
    controlInFlight = true;
    advice.set(`${working}...`);
    try {
        const res = await fetch(`${MARKDOWN_SERVER_URL}${DOC_BASE_ASSIGNMENT}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const result = (await res.json()) as { ok: boolean; action: string; detail?: string };
        appLog("Assignment", path, result.action, result.detail ?? "");
        if (!result.ok) {
            advice.set(
                `Couldn't ${working.toLowerCase()}\n${result.detail ?? ""}`.trim(),
            );
        }
    } catch (err) {
        appLog("Assignment", path, "failed", err);
        advice.set("Server unreachable\nTap to retry");
    } finally {
        controlInFlight = false;
        // The reader's next `status` event repaints the box with the truth.
    }
}

/** The menu's "Back" entry — what a double tap used to do on its own. */
function leavePage(): void {
    page.leave();
    navigateBack();
}

/** Called by main.ts after the assignment page containers are built. */
export async function enterAssignmentPage(): Promise<void> {
    await page.enter();
    updateFeedback();
}

/** Tear down live connections when leaving the page. */
export function leaveAssignmentPage(): void {
    menu.close(false); // no repaint: these containers are about to go
    page.leave();
}

export function handleAssignmentPageEvent(gesture: GESTURE_EVENTS): void {
    if (menu.handleGesture(gesture)) return;
    // Double tap opens the menu here, so it never reaches docPage's back
    // gesture — the menu's own "Back" entry is the way out of the page.
    if (gesture === GESTURE_EVENTS.DOUBLE_TAP) {
        // Not while a control is in flight: the entries are built from job
        // state that is about to change.
        if (!controlInFlight) menu.open();
        return;
    }
    page.handleGesture(gesture);
}
