// The Assignment page: whatever the lookcam reader has transcribed off the
// paper so far, re-rendered as it fills in, plus a corner box that carries the
// model's camera advice and doubles as the control surface.
//
// Same document machinery as the AI page (docPage.ts); the differences are the
// endpoint, a `status` SSE listener, and the gestures:
//
//   tap         the obvious NON-DESTRUCTIVE thing — start, resume, or stop
//               (the server decides). Never a rescan: that throws the
//               transcription away, which no temple tap should be able to do.
//   swipe       page through the document
//   double tap  open the action menu (swipe to choose, tap to confirm)
//
// The menu exists because the obvious thing isn't always what you want: a
// half-read assignment can be resumed OR scrapped and rescanned, and only you
// know which. It takes over double-tap — leaving the page becomes its "Back"
// entry — because tap and the swipes are all spoken for, and the SDK has no
// long-press. It draws as a centred panel listing every action, mirrored one
// line at a time in the footer so it survives being hidden behind the tiles.
// Like the AI page's, it opens on the variant render rather than a black
// backdrop, so the transcription stays readable around it.
//
// The reader files every scan away on /reset and can serve them back
// (`/archive`), so the menu also picks an earlier one — the same version picker
// the AI page has for solutions. Nothing pinned means the live scan.
//
// Two displays, deliberately split:
//
//   the corner box   what to do with the CAMERA — framing advice while a job
//                    runs, what a tap does when one isn't. Two lines, and it
//                    keeps its background even while the menu is up.
//   the footer       whether anything is HAPPENING — page number, capture
//                    count, how long since the last one landed, which version
//                    you are reading. It is a whole line wide and nothing can
//                    cover it.

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
import { backdrop, createMenu, type MenuEntry } from "./menu";
import { createPanel } from "./panel";
import { navigateBack } from "./main";
import { appLog } from "./debug";

/** Named actions the document server accepts (see server/assignment.ts). */
type ControlAction = "start" | "stop" | "reset" | "restart" | "extend";

// A control takes a round trip to the reader; ignore gestures until it lands so
// an impatient double-press can't start and immediately stop a job.
let controlInFlight = false;

/** Where the menu is: its top level, or the version picker it opens. */
let menuMode: "root" | "versions" = "root";
/** null follows the live scan; a number pins the reader to an archived one. */
let selectedVersion: number | null = null;

/**
 * What a control is doing, and what went wrong if it didn't.
 *
 * The reader's own status event is the truth, but it arrives after a round trip
 * through two servers — and a refusal ("a job is already running") is never
 * reported by it at all, because from the reader's point of view nothing
 * happened. Both need somewhere to live in the meantime. Same shape as the AI
 * page's `requesting` / `requestError`.
 */
let working: string | null = null;
let controlError: string | null = null;

// Captures land every few seconds, so "how long since the last one" is the
// number that says the job is alive. Counted locally: the reader only speaks
// when something happens, and silence is exactly what we are measuring.
let ticker: ReturnType<typeof setInterval> | null = null;
const TICK_MS = 1_000;

function status(): AssignmentStatus | null {
    return GlobalState.assignmentStatus;
}

/** Every scan the reader still holds, newest first. */
function versions(): AssignmentStatus["versions"] {
    return status()?.versions ?? [];
}

/** Whether the page is showing the live scan rather than an archived one. */
function onLive(): boolean {
    return selectedVersion === null;
}

/** "12s" / "3m 04s" — how long since something last happened. */
function elapsed(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    if (total < 60) return `${total}s`;
    return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

/** "26 Jul 11:58" from the reader's ISO timestamps. */
function formatDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "?";
    return `${String(date.getDate()).padStart(2, "0")} ${date.toLocaleString([], {
        month: "short",
    })} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Repaint the box, whatever is under it, and the footer. */
function repaint(): void {
    updateFeedback();
    syncOverlay();
    void page.enqueue(() => page.updatePager());
}

/** Tick once a second while a job runs, so "12s ago" actually moves. */
function syncTicker(): void {
    const running = Boolean(status()?.running) && onLive();
    if (running && !ticker) {
        ticker = setInterval(repaint, TICK_MS);
    } else if (!running && ticker) {
        clearInterval(ticker);
        ticker = null;
    }
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
    // Ahead of the reader's state: a control that was refused is about the
    // thing you just did, and no status event will ever mention it.
    if (controlError) return controlError;
    if (working) return `${working}...`;
    if (s && s.upstream !== "open") return `Reader ${s.upstream}`;
    if (!state.pages.length) return s?.running ? "Reading the page..." : state.status;

    const pages = `${state.currentPage + 1} / ${state.pages.length}`;
    return `${pages}${progressLabel()}`;
}

/**
 * What the footer adds to the page number: whether anything is happening, or
 * which archived scan you are looking at instead.
 */
function progressLabel(): string {
    const s = status();
    if (!s) return "";

    // Pinned to history — then nothing about the live job is what you want to
    // know, and which scan this is very much is.
    if (!onLive()) {
        const entry = versions().find((v) => v.version === selectedVersion);
        return entry
            ? `  -  v${entry.version} ${formatDate(entry.created_at)}`
            : `  -  v${selectedVersion}`;
    }

    if (s.running) {
        // The capture number alone looks identical whether the job is working
        // or wedged. The age is the part that moves.
        const since =
            s.last_capture_at === null
                ? "starting"
                : `${elapsed(Date.now() - s.last_capture_at)} ago`;
        return `  -  capture ${s.captures}, ${since}`;
    }

    if (s.done) return `  -  done, ${s.problems} problems`;
    if (s.reason === "max_captures") return `  -  stopped at the ${s.captures} limit`;
    if (s.captures > 0) return `  -  stopped at capture ${s.captures}`;
    return "  -  nothing read yet";
}

/**
 * The corner box. It is always on screen — border width is part of the page
 * definition and can't be upgraded, so a box that appeared and disappeared
 * would need a full page rebuild (and a re-push of all four tiles) every time
 * a job started. Instead it always shows the most useful thing available:
 * camera advice while capturing, otherwise what a tap will do.
 */
function feedbackText(): string {
    // What you just asked for, before anything upstream has reacted to it.
    if (controlError) return `${controlError}\nTap to retry`;
    if (working) return `${working}...`;

    const s = status();
    if (!s) return "Connecting...";
    if (s.upstream === "disabled") return "No reader configured";
    if (s.upstream !== "open") return `Reader ${s.upstream}\n${s.error ?? ""}`.trim();

    // Reading history: the camera is irrelevant, and the box would otherwise
    // give live advice about a document from yesterday.
    if (!onLive()) {
        const entry = versions().find((v) => v.version === selectedVersion);
        return `Archived scan v${selectedVersion}\n${
            entry ? `${entry.capture_count} captures, ${entry.problems} problems` : "2x = menu"
        }`;
    }

    if (s.running) {
        const f = s.feedback;
        if (!f) return `Capture ${s.captures}...\nTap to stop`;
        // advice_detail is a full sentence; camera_advice is the enum. Lead with
        // the enum so the useful word survives even if the box clips.
        const head =
            f.camera_advice && f.camera_advice !== "ok"
                ? `! ${f.camera_advice}`
                : "OK framing";
        // The edges the model says are cut off are the single most actionable
        // thing it produces, and they were only ever in `advice_detail` prose.
        const cut = f.cut_off_edges.length ? ` (${f.cut_off_edges.join(",")} cut)` : "";
        return `${head}${cut}\n${f.advice_detail}`;
    }

    // Neither of these offers a tap: the only thing left to do to a page that
    // is already read is throw it away and start again, and that is not
    // something a temple tap should be able to do. See defaultAction.
    if (s.done) return `Done - ${s.problems} problems\n2x = menu to rescan`;
    if (s.error) return `Failed: ${s.error}\nTap to retry`;
    if (s.reason === "max_captures") return "Hit capture limit\n2x = menu to rescan";
    if (s.reason === "stopped") return `Stopped at ${s.captures}\nTap to resume - 2x = menu`;
    return "Tap to start reading";
}

// ── the action menu ─────────────────────────────────────────────────────────

const control = (label: string, action: ControlAction): MenuEntry => ({
    label,
    run: () => {
        // Every control acts on the LIVE scan, so stop reading history first —
        // otherwise the job you just started reports into a page pinned to a
        // document it will never touch.
        openVersion(null);
        void send("/control", { action }, label);
    },
});

/**
 * What's worth offering here, most likely first — ordering matters more than
 * usual, because the first entry is what a tap-tap does. Rebuilt on every open,
 * so it always reflects where the job actually is.
 */
function buildMenu(): MenuEntry[] {
    return menuMode === "versions" ? buildVersionMenu() : buildRootMenu();
}

function buildRootMenu(): MenuEntry[] {
    const s = status();
    const captures = s?.captures ?? 0;
    // Back leads. It is what double-tap did before the menu took that gesture,
    // so double-tap-tap still means "leave" and the old reflex keeps working.
    // It also makes the destructive entries something you travel to rather than
    // something you land on.
    const items: MenuEntry[] = [{ label: "Back", run: leavePage }];

    // Reading an archived scan is a mode, and the way out of it leads. None of
    // the controls below are about the document on screen while it is pinned.
    if (!onLive()) {
        items.push({ label: "Back to live scan", run: () => openVersion(null) });
        if (versions().length > 1) {
            items.push({ label: "Open a version...", run: () => openMenu("versions") });
        }
        items.push({ label: "Close", run: () => {} });
        return items;
    }

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

    // More than the live one means there is something to choose between.
    if (versions().length > 1) {
        items.push({ label: "Open a version...", run: () => openMenu("versions") });
    }

    // Dismiss: createMenu closes before it runs an entry, so by this point
    // there is nothing left to do.
    items.push({ label: "Close", run: () => {} });
    return items;
}

/**
 * The picker: every scan the reader still holds, newest first, by the time it
 * was started. The live one is labelled as such and un-pins rather than pinning
 * to its number — a scan you resume should go on updating, and its version
 * becomes an archived one the moment somebody resets.
 */
function buildVersionMenu(): MenuEntry[] {
    const items: MenuEntry[] = [{ label: "Back", run: () => openMenu("root") }];

    for (const entry of versions()) {
        const live = !entry.archived;
        const current = onLive() ? live : selectedVersion === entry.version;
        items.push({
            label:
                `${current ? "*" : " "}v${entry.version} ${formatDate(entry.created_at)}` +
                (live ? " live" : ` (${entry.problems}p)`),
            run: () => {
                menuMode = "root";
                openVersion(live ? null : entry.version);
            },
        });
    }
    return items;
}

/** Open the menu, or move it between its two levels. */
function openMenu(mode: "root" | "versions"): void {
    menuMode = mode;
    menu.open();
}

/**
 * Point the reader at one archived scan, or back at the live one.
 *
 * Reloads rather than refetching, for the same reason the AI page does: the
 * document stream is subscribed per version, so a pinned page would go on
 * hearing about the scan it is pinned to and never learn the live one moved.
 */
function openVersion(version: number | null): void {
    if (selectedVersion === version) return;
    selectedVersion = version;
    controlError = null;
    syncTicker();
    void page.reload();
}

/**
 * The panel's first line. It says what the job is doing, because which entries
 * exist depends entirely on that — "Stop" is only offered while something is
 * running, and without this the menu gives no hint as to why it's missing.
 */
function menuHeading(): string {
    if (menuMode === "versions") return "SCANS - NEWEST FIRST";
    if (controlError) return "THAT DIDN'T WORK";
    if (!onLive()) return `ARCHIVED SCAN v${selectedVersion}`;

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
    onPaint: async () => {
        // The footer mirrors the selection, and the variant render may have
        // arrived since the menu opened — a swipe is the cheapest place to
        // notice either.
        syncOverlay();
        await page.updatePager();
    },
    // The document lives in the image tiles and a text container is
    // transparent, so something has to cover it. syncOverlay decides what.
    backdrop: {
        show: () => {
            syncOverlay();
            return Promise.resolve();
        },
        hide: () => {
            syncOverlay();
            return Promise.resolve();
        },
    },
});

/**
 * What covers the document while the menu is up.
 *
 * Unlike the AI page there is no modal button here — the assignment page is
 * always a reader — so this is only ever the menu, and the menu always prefers
 * the variant render: the transcription with a dark box where the panel sits,
 * so you can still see what you are choosing about. The all-black backdrop is
 * the fallback until that render lands, because a menu over an uncovered
 * document is text on text.
 */
function syncOverlay(): void {
    void page.enqueue(async () => {
        if (menu.isOpen()) {
            if (!(await page.overlayVariant())) await page.overlayTiles(backdrop());
        } else if (page.isMasked()) {
            await page.restoreTiles();
        }
    });
}

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
    onPrimaryAction: primaryAction,
    pagerLabel,
    query: () => docQuery(),
    // The same scan with the menu's rectangle reserved, so the menu can open
    // without taking the transcription off the screen.
    variantQuery: () => docQuery("overlay=menu"),
    // Same fallback as the AI page: a dropped stream would otherwise freeze the
    // camera advice and the running/stopped state on whatever they last said.
    statusPath: `${DOC_BASE_ASSIGNMENT}/status`,
    events: {
        status: (data) => {
            GlobalState.assignmentStatus = data as AssignmentStatus;
            syncTicker();
            // Status moves far more often than the document does, so this only
            // touches the two text containers — never the image tiles.
            repaint();
        },
    },
    // Tiles land on their own schedule; keep the box in step with them.
    afterShow: async () => updateFeedback(),
});

/**
 * What a tap does.
 *
 * On an archived scan it comes back to the live one rather than starting
 * anything. A tap is the page's one unguarded gesture, and "start scanning the
 * paper in front of me" is not a thing to do by accident while reading
 * yesterday's — the menu is where you go to act on the live job from here.
 */
function primaryAction(): void {
    if (!onLive()) {
        openVersion(null);
        return;
    }
    // Rescanning archives the transcription and starts from nothing. The server
    // refuses to reach it from a tap too (defaultAction returns "none"), but
    // swallowing it here means no round trip and no flicker for a gesture that
    // was never going to do anything.
    const s = status();
    if (s?.done || s?.reason === "max_captures") return;
    void send("/toggle", undefined, toggleLabel());
}

/**
 * What /toggle is about to do, named locally so the box can say it during the
 * round trip. The server makes the real decision (see defaultAction there) —
 * this only has to be right often enough to be worth reading, and it is a label
 * rather than a command, so being wrong costs a word and not an action.
 */
function toggleLabel(): string {
    const s = status();
    if (s?.running) return "Stopping";
    if ((s?.captures ?? 0) > 0) return "Resuming";
    return "Starting";
}

/** The query for the scan the page is on: pinned, or whatever is live. */
function docQuery(extra?: string): string {
    const parts: string[] = [];
    if (selectedVersion !== null) parts.push(`version=${selectedVersion}`);
    if (extra) parts.push(extra);
    return parts.length ? `?${parts.join("&")}` : "";
}

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
async function send(path: string, body: unknown, label: string): Promise<void> {
    if (controlInFlight) return;
    controlInFlight = true;
    controlError = null;
    // Shown in BOTH places, and set before the request leaves. A control is two
    // servers and a camera away; without this the page sits on its old state
    // for the whole round trip and the tap reads as ignored.
    working = label;
    repaint();
    try {
        const res = await fetch(`${MARKDOWN_SERVER_URL}${DOC_BASE_ASSIGNMENT}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const result = (await res.json()) as { ok: boolean; action: string; detail?: string };
        appLog("Assignment", path, result.action, result.detail ?? "");
        if (!result.ok) {
            // Kept until you act on it: the reader never emits an event for a
            // refusal, so nothing else will ever repaint this away.
            controlError = `Couldn't ${label.toLowerCase()}: ${result.detail ?? "refused"}`;
        }
    } catch (err) {
        appLog("Assignment", path, "failed", err);
        controlError = "The document server is unreachable";
    } finally {
        controlInFlight = false;
        working = null;
        // The reader's next `status` event repaints the box with the truth.
        repaint();
    }
}

/** The menu's "Back" entry — what a double tap used to do on its own. */
function leavePage(): void {
    page.leave();
    navigateBack();
}

/** Called by main.ts after the assignment page containers are built. */
export async function enterAssignmentPage(): Promise<void> {
    menuMode = "root";
    // Guesses about a control issued on a previous visit; the status stream is
    // about to say what is actually happening.
    working = null;
    controlError = null;
    // The container is new and blank; the panel still remembers the last
    // visit's text and would dedup the repaint away. See Panel.reset().
    advice.reset();
    await page.enter();
    syncTicker();
    updateFeedback();
}

/** Tear down live connections when leaving the page. */
export function leaveAssignmentPage(): void {
    if (ticker) {
        clearInterval(ticker);
        ticker = null;
    }
    menu.close(false); // no repaint: these containers are about to go
    page.leave();
}

export function handleAssignmentPageEvent(gesture: GESTURE_EVENTS): void {
    if (menu.handleGesture(gesture)) return;
    // Double tap opens the menu here, so it never reaches docPage's back
    // gesture — the menu's own "Back" entry is the way out of the page.
    if (gesture === GESTURE_EVENTS.DOUBLE_TAP) {
        // Not while a control is in flight: the entries are built from job
        // state that is about to change. Always at the top level — a version
        // picker left open from last time is not what a double tap asks for.
        if (!controlInFlight) openMenu("root");
        return;
    }
    // A tap acknowledges the error it is retrying past; leaving it up would
    // make the box keep blaming the control you have already moved on from.
    if (gesture === GESTURE_EVENTS.TAP && controlError) {
        controlError = null;
        repaint();
    }
    page.handleGesture(gesture);
}
