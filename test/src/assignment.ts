// The Assignment page: whatever the lookcam reader has transcribed off the
// paper so far, re-rendered as it fills in. A reader, and only a reader.
//
// IT NO LONGER SCANS. Start, stop, resume, rescan and clear moved to the Camera
// page, which shows the live view they are about. Two reasons. A tap here means
// "turn the page" — the ordinary thing to do with a document — and it could
// previously start a job instead, which is a great deal to hang off a gesture
// you make while reading. And the controls were on the one screen that cannot
// show you what the camera is doing, so acting on them meant guessing.
//
// Same document machinery as the AI page (docPage.ts); the differences are the
// endpoint, a `status` SSE listener, and the gestures:
//
//   tap         turn the page
//   swipe       page through the document
//   double tap  open the menu (swipe to choose, tap to confirm)
//
// The menu is now navigation only: leave, or open one of the earlier scans the
// reader filed away on /reset (`/archive`) — the same version picker the AI
// page has for solutions. Nothing pinned means the live scan, which keeps
// updating as captures land. It draws as a centred panel, mirrored one line at
// a time in the footer so it survives being hidden behind the tiles, and it
// opens on the variant render rather than a black backdrop so the transcription
// stays readable around it.
//
// Two displays, deliberately split:
//
//   the corner box   WHAT YOU ARE READING — how much of the sheet is in hand,
//                    or which archived scan is pinned. Two lines, and it keeps
//                    its background even while the menu is up.
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
    Z_FEEDBACK,
} from "./constants";
import { GlobalState, type AssignmentStatus, type DocState } from "./state";
import { createDocPage } from "./docPage";
import { backdrop, createMenu, type MenuEntry } from "./menu";
import { createPanel } from "./panel";
import { navigateBack } from "./main";
import { ago } from "./utils";

/** Where the menu is: its top level, or the version picker it opens. */
let menuMode: "root" | "versions" = "root";
/** null follows the live scan; a number pins the reader to an archived one. */
let selectedVersion: number | null = null;

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

/**
 * How much text a line of each strip holds.
 *
 * Measured against what is known to fit rather than from font metrics, which
 * this app does not have: the menu's footer line ("> Cancel this solve   2/3
 * tap=ok", 34 characters) fills a 576px strip comfortably, so ~14px a
 * character. The advice box is 288px wide with 6px of padding on each side.
 *
 * Overflow is not a cosmetic problem here. A text container that does not fit
 * its content gets a scroll bar from the host and spills PAST its background —
 * and that background is baked into the tiles, so the overspill lands on bare
 * document text with nothing behind it. That is the overlapping text and the
 * scroll bar that does nothing: there is no gesture routed to it to scroll.
 */
const ADVICE_COLS = 20;
const FOOTER_COLS = 40;

/** Hard-clip one line to what its strip can draw. */
function clip(text: string, cols: number): string {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length <= cols ? line : `${line.slice(0, cols - 1)}…`;
}

/** Clip every line of a panel, and never hand it more lines than it has. */
function fitBox(lines: string[], rows = 2, cols = ADVICE_COLS): string {
    return lines
        .filter((l) => l !== "")
        .slice(0, rows)
        .map((l) => clip(l, cols))
        .join("\n");
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

    // Ahead of the live state: these tiles came out of the on-device cache
    // because the server was unreachable, and a stale document that says
    // nothing is indistinguishable from a current one.
    if (state.cachedAt) return clip(`Offline - cached ${ago(state.cachedAt)}`, FOOTER_COLS);

    const s = status();
    if (s && s.upstream !== "open") return `Reader ${s.upstream}`;
    if (!state.pages.length) return s?.running ? "Reading the page..." : state.status;

    const pages = `${state.currentPage + 1} / ${state.pages.length}`;
    return clip(`${pages}${progressLabel()}`, FOOTER_COLS);
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
        return `  -  c${s.captures} ${since}, ${readLabel()}`;
    }

    // "done" is not self-evidently the whole sheet: a scan finished under the
    // old rule, or restored from a state file that predates the check, can be
    // complete in every problem it holds and still have missed the bottom of
    // the page. readLabel says so.
    if (s.done) return `  -  done, ${readLabel()}`;
    if (s.reason === "max_captures") return `  -  hit the ${s.captures} limit, ${readLabel()}`;
    if (s.captures > 0) return `  -  stopped c${s.captures}, ${readLabel()}`;
    return "  -  nothing read yet";
}

/**
 * The corner box: WHAT YOU ARE READING, and how complete it is.
 *
 * It is always on screen — border width is part of the page definition and
 * can't be upgraded, so a box that appeared and disappeared would need a full
 * page rebuild (and a re-push of all four tiles) every time the state changed.
 *
 * It used to carry live camera advice and the start/stop label. Both belong to
 * the Camera page now, and repeating the advice here would be worse than
 * useless: "Move camera DOWN" in front of a transcription invites you to act on
 * it from the one screen that can't show you the result.
 */
function feedbackText(): string {
    const s = status();
    if (!s) return "Connecting...";
    if (s.upstream === "disabled") return "No reader configured";
    if (s.upstream !== "open") return fitBox([`Reader ${s.upstream}`, s.error ?? ""]);

    // Pinned to history: which scan this is matters, and nothing about the live
    // job does.
    if (!onLive()) {
        const entry = versions().find((v) => v.version === selectedVersion);
        return fitBox([
            `Archived v${selectedVersion}`,
            entry ? `${entry.problems} problems` : "2x = menu",
        ]);
    }

    if (s.running) return fitBox([`Reading - c${s.captures}`, readLabel()]);
    if (s.done) return fitBox([`Done - ${s.problems} problems`, readLabel()]);
    if (s.reason === "max_captures") return fitBox(["Hit capture limit", readLabel()]);
    // Every remaining state is one you fix on the other page, so say so rather
    // than offering a gesture this page no longer has.
    if (s.captures > 0) return fitBox([`Stopped at ${s.captures}`, readLabel()]);
    return fitBox(["Nothing read yet", "Scan on Camera page"]);
}

// ── the action menu ─────────────────────────────────────────────────────────

/**
 * Navigation only. Rebuilt on every open, so it always reflects which scan is
 * on screen and how many there are to choose between.
 */
function buildMenu(): MenuEntry[] {
    return menuMode === "versions" ? buildVersionMenu() : buildRootMenu();
}

function buildRootMenu(): MenuEntry[] {
    // Back leads. It is what double-tap did before the menu took that gesture,
    // so double-tap-tap still means "leave" and the old reflex keeps working.
    const items: MenuEntry[] = [{ label: "Back", run: leavePage }];

    // Reading an archived scan is a mode, and the way out of it leads.
    if (!onLive()) {
        items.push({ label: "Back to live scan", run: () => openVersion(null) });
    }

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

/**
 * How much of the sheet is actually in hand.
 *
 * A bare problem count says nothing about whether the scan is finished: six
 * problems of which two are half-read is not six problems, and neither is six
 * problems on a sheet whose bottom third has never been in frame. The reader
 * gates `done` on exactly these two facts, so the footer shows them.
 */
function readLabel(): string {
    const s = status();
    if (!s) return "";
    const whole = s.problems
        ? `${s.problems_complete}/${s.problems} read`
        : "nothing read yet";
    // The gate that is easiest to be surprised by: every problem complete and
    // the job still going, because the page has never been seen end to end.
    // Kept to one word: the footer is one line and this is the tail of it.
    return s.full_page_seen ? whole : `${whole}, partial`;
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
    syncTicker();
    void page.reload();
}

/**
 * The panel's first line: what the reader is doing to the document you are
 * looking at. Not a control any more, but still the context for "Back to live
 * scan" — a scan that is still running is one whose pages will keep changing
 * under you.
 */
function menuHeading(): string {
    if (menuMode === "versions") return "SCANS - NEWEST FIRST";
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

// The corner box. Its dark background and frame come baked into the
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
    // A reader: tap and swipe both page, and nothing here can start a job.
    tapAction: "page",
    pagerLabel,
    query: () => docQuery(),
    // The same scan with the menu's rectangle reserved, so the menu can open
    // without taking the transcription off the screen.
    variantQuery: () => docQuery("overlay=menu"),
    // Same fallback as the AI page: a dropped stream would otherwise freeze the
    // capture count and the running/stopped state on whatever they last said.
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

/** The query for the scan the page is on: pinned, or whatever is live. */
function docQuery(extra?: string): string {
    const parts: string[] = [];
    if (selectedVersion !== null) parts.push(`version=${selectedVersion}`);
    if (extra) parts.push(extra);
    return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * Repaint the corner box. It stays up while the menu is open — the menu is
 * mirrored in the footer, so what you are choosing between and what you are
 * reading are both on screen.
 */
function updateFeedback(): void {
    advice.set(feedbackText());
}

/** The menu's "Back" entry — what a double tap used to do on its own. */
function leavePage(): void {
    page.leave();
    navigateBack();
}

/** Called by main.ts after the assignment page containers are built. */
export async function enterAssignmentPage(): Promise<void> {
    menuMode = "root";
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
        // Always at the top level — a version picker left open from last time
        // is not what a double tap asks for.
        openMenu("root");
        return;
    }
    page.handleGesture(gesture);
}
