// The AI page: the solution to the assignment on the paper in front of you —
// and, when there isn't one yet, the button that goes and gets it.
//
//   tap         turn the page, or press the button when it's up
//   swipe       page through the solution
//   double tap  open the action menu (solve again, cancel, open a version, back)
//
// The document is whatever a Claude routine last solved (server/solver.ts). When
// no solution answers the *current* scan — nothing solved yet, or the camera has
// moved to a new sheet — the page stops being a reader and becomes a button:
// a tap asks the server to hand the transcription to the routine, and the box
// then reports progress until the markdown arrives and the tiles redraw.
//
// The button is modal, and deliberately so: while there is nothing to read,
// reading is not what you are here for. It borrows the action menu's rectangle
// and dark backdrop wholesale (see SOLVE_RECT) — a text container is
// transparent, so without the backdrop this would be a button drawn over
// somebody else's algebra. It takes that background from the variant render,
// so the previous solution stays readable around it — including in the state
// where the button is literally talking about it ("shown: earlier scan").
//
// The one exception is a solve IN FLIGHT, which blacks the document out
// wholesale: that solution is being replaced, and a solve running is the page's
// whole state whether you started it here or walked back onto the page while it
// ran.
//
// The MENU is the opposite case. It is about the solution, so blacking the
// solution out to show it reads as the page having lost the document. It opens
// on the variant render instead — the same tiles with a dark box exactly where
// the panel sits (see HUD_MENU in server/render/constants.ts) — so you can read
// the answer around the menu that talks about it.
//
// Which answer that is, is a choice: the menu's version picker pins the reader
// to any solution the server still has, and the footer says which one you are
// on. Nothing pinned means the latest, which is also what a new solve returns
// you to.

import {
    DOC_BASE_SOLUTION,
    DOC_MENU_ID,
    DOC_SOLVE_ID,
    GESTURE_EVENTS,
    MARKDOWN_SERVER_URL,
    SOLVE_RECT,
    Z_SOLVE,
} from "./constants";
import { GlobalState, type DocState, type SolverStatus } from "./state";
import { createDocPage } from "./docPage";
import { backdrop, createMenu, type MenuEntry } from "./menu";
import { createPanel } from "./panel";
import { navigateBack } from "./main";
import { appLog } from "./debug";

/** Where the solve loop lives on the document server. */
const SOLVE_BASE = "/solution";

// A solve request is a round trip that ends in a cloud session being started;
// ignore gestures until it lands so an impatient double-press can't queue two.
let requestInFlight = false;
/** null follows the live/latest solution; a number pins the reader to history. */
let selectedSolutionId: number | null = null;
/** Where the menu is: its top level, or the version picker it opens. */
let menuMode: "root" | "versions" = "root";

/**
 * A solve has been asked for and no status event has agreed yet.
 *
 * Without this, pressing "Solve again" does nothing visible for the length of a
 * round trip that ends in a cloud session being started. The server is still
 * reporting `solved`, so the page is still a reader, still showing the solution
 * you just asked to replace — with the word "Solving..." written into a
 * transparent container over the top of it. You cannot tell a slow request from
 * an ignored tap, which is exactly when you tap again.
 *
 * So the button goes up on the tap, locally, and the first real status event
 * takes over. It is a guess about the server, and it is allowed to be wrong for
 * REQUEST_GRACE_MS and no longer.
 */
let requesting = false;
let requestTimer: ReturnType<typeof setTimeout> | null = null;
const REQUEST_GRACE_MS = 30_000;

/**
 * A request the server refused, or couldn't be made at all.
 *
 * It gets the button too, for the same reason `requesting` does: no status
 * event will ever mention it — as far as the server is concerned nothing
 * happened — so it would otherwise be written into a transparent box over the
 * document and be unreadable. It stays until you do something about it.
 */
let requestError: string | null = null;

// Progress is the one thing the server can't push often enough — a queued run
// sends no events at all while it waits for the agent to pick it up. So the
// elapsed time is counted locally from the last status we saw.
let statusReceivedAt = 0;
let ticker: ReturnType<typeof setInterval> | null = null;
// Once a second, because the number is seconds and a clock that moves in jumps
// of five reads as a stalled page rather than a running one — which is the one
// thing this display exists to rule out. Both writes it causes are text
// container upgrades of a few bytes (the tiles are the expensive thing), and
// both dedup, so a label that hasn't changed costs nothing on the wire.
const TICK_MS = 1_000;

function status(): SolverStatus | null {
    return GlobalState.solverStatus;
}

/** The saved solutions, newest first, as the server sends them. */
function history(): SolverStatus["solution_history"] {
    return status()?.solution_history ?? [];
}

function setRequesting(on: boolean): void {
    requesting = on;
    if (requestTimer) {
        clearTimeout(requestTimer);
        requestTimer = null;
    }
    if (!on) return;
    // Never leave the page claiming a solve that never started. If no status
    // event ever agrees with us — the request was lost, the stream is down —
    // fall back to whatever the server last said rather than sitting on a
    // backdrop forever.
    requestTimer = setTimeout(() => {
        requestTimer = null;
        requesting = false;
        repaint();
    }, REQUEST_GRACE_MS);
}

/** The box, whatever is under it, and the footer that mirrors both. */
function repaint(): void {
    paintButton();
    void page.enqueue(() => page.updatePager());
}

/** How long the current run has been going, status age plus local drift. */
function runElapsedMs(): number {
    const s = status();
    if (!s?.run) return 0;
    return s.run.age_ms + (Date.now() - statusReceivedAt);
}

/** "45s" / "2m 10s" — short enough for a footer, clear enough to wait against. */
function elapsed(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    if (total < 60) return `${total}s`;
    return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

/**
 * Whether the page is a button right now.
 *
 * `solved` is the only state with nothing to ask for. Note that a *stale*
 * solution still counts as no solution: it answers a sheet of paper that is no
 * longer under the camera, so the button comes back on its own when you turn the
 * page — nothing to clear, nothing to remember.
 */
function buttonUp(): boolean {
    if (requesting) return true; // we asked; the server just hasn't said so yet
    if (requestError) return true; // and it has to be readable to be an error
    // Reading history is reading. You went into the menu and asked for this
    // document by name, so nothing modal goes over it — and the button's states
    // are all about the LIVE solve, which is not what you are looking at. It is
    // the same call the assignment page makes for an archived scan. Solving is
    // still one menu entry away, next to "Back to latest".
    if (selectedSolutionId !== null) return false;
    const s = status();
    if (!s) return false; // pre-connection: don't flash a button we can't press
    return s.state !== "solved";
}

/** Whether a tap on the button would actually start something. */
function tappable(): boolean {
    if (requesting) return false; // one is already on its way
    if (requestError) return true; // "TAP TO RETRY" means it
    const s = status();
    return s?.state === "idle" || s?.state === "failed";
}

// ── what the button says ────────────────────────────────────────────────────

/**
 * The box's text. Five short lines at most — it is the menu's rectangle, and the
 * host clips rather than scrolls.
 *
 * Every state answers the same two questions, in this order: what is happening,
 * and what does a tap do now. Anything else (which routine, which model, how
 * many solutions are on disk) belongs in a log, not on a display read at arm's
 * length.
 */
function buttonText(): string {
    // Ahead of the server's own account of things: this is the gap between the
    // tap and the first status event, and during it the server still says
    // "solved". Same headline as the wait that follows, because it is the same
    // wait — only the second line knows the difference.
    if (requestError) {
        return ["REQUEST FAILED", "", requestError.slice(0, 80), "", "TAP TO RETRY"].join("\n");
    }
    if (requesting) {
        return ["CLAUDE IS SOLVING", "", "starting...", "", "please wait"].join("\n");
    }

    const s = status();
    if (!s) return "Connecting...";

    switch (s.state) {
        case "solved":
            return " ";

        case "no_assignment":
            return [
                "NOTHING TO SOLVE",
                "",
                s.assignment.available
                    ? "the reader has not read"
                    : "no assignment reader",
                s.assignment.available ? "any problems yet" : "is configured",
                "",
                "2x = menu",
            ].join("\n");

        case "idle": {
            const lines = ["SOLVE WITH CLAUDE", ""];
            lines.push(`${s.assignment.problems} problems read`);
            // The reader often has every problem legible well before it declares
            // itself done, and only you can see the paper — so this is a warning,
            // not a veto.
            if (!s.assignment.done) lines.push("assignment incomplete");
            // A solution IS on screen behind this, for the previous sheet. Say so,
            // or the button looks like it has forgotten what it already did.
            else if (s.solution?.stale) lines.push("(shown: earlier scan)");
            lines.push("", "TAP TO RUN");
            return lines.join("\n");
        }

        // One visible state for the whole time a solve is in flight. The server
        // distinguishes "the agent hasn't picked it up yet" from "it is working",
        // because it has to time those out differently — but from here they are
        // the same wait, and naming the seam only invited the question of whether
        // anything was actually happening.
        case "queued":
        case "solving":
            // The exception, because it is the one case where the answer is
            // "nothing, and it won't happen on its own".
            if (s.state === "queued" && s.run?.trigger !== "triggered") {
                return [
                    "WAITING",
                    "",
                    "no solver is configured,",
                    "so nothing is working",
                    "on this yet",
                    "",
                    "2x = menu",
                ].join("\n");
            }
            return [
                "CLAUDE IS SOLVING",
                "",
                elapsed(runElapsedMs()),
                "",
                "2x = menu to cancel",
            ].join("\n");

        case "failed":
            return [
                "SOLVE FAILED",
                "",
                // The reason is a sentence from the agent or a timeout note; two
                // lines of it is all that fits, and the log has the rest.
                (s.run?.error ?? "no reason given").slice(0, 80),
                "",
                "TAP TO RETRY",
            ].join("\n");
    }
}

/**
 * The footer. One line, and it is the strip no tile can cover — so it repeats
 * the button's gist for the case where the panel is invisible on this host (the
 * same insurance the menu's `line()` provides).
 */
function pagerLabel(state: DocState): string {
    const selection = menu.line();
    if (selection) return selection;

    // Ahead of everything else, because it explains a blank panel that otherwise
    // looks like a bug in the document: the tiles never reached the glasses.
    if (state.linkError) return "Glasses link error - tiles not sent";

    if (requestError) return "Request failed - tap to retry";
    if (requesting) return "Starting a solve...";

    // Pinned to history: the live solve state is not what this strip is for.
    // Without this it went on saying "Tap to solve" over a document you had
    // opened deliberately — and there is no longer a button to tap.
    if (selectedSolutionId !== null) {
        if (!state.pages.length) return state.status;
        return `${state.currentPage + 1} / ${state.pages.length}${openedLabel()}`;
    }

    const s = status();
    if (!s) return state.status;

    switch (s.state) {
        case "no_assignment":
            return "Nothing to solve yet";
        case "idle":
            return s.assignment.done
                ? "Tap to solve"
                : "Tap to solve (page incomplete)";
        case "queued":
        case "solving":
            return s.state === "queued" && s.run?.trigger !== "triggered"
                ? "Waiting - no solver configured"
                : `Solving - ${elapsed(runElapsedMs())}`;
        case "failed":
            return "Solve failed - tap to retry";
        case "solved":
            if (!state.pages.length) return state.status;
            return `${state.currentPage + 1} / ${state.pages.length}${openedLabel()}`;
    }
}

/**
 * Which solution you are reading. A suffix rather than a line of its own — the
 * footer is one strip and paging is what you look at it for — and empty when
 * there is nothing to say, which is a deployment still showing solution.md.
 */
function openedLabel(): string {
    const items = history();
    if (!items.length) return "";

    const opened =
        selectedSolutionId === null
            ? items[0]
            : items.find((item) => item.id === selectedSolutionId);
    // Pinned to something older than the handful the server sends back. Say so:
    // "v?" beats a footer that quietly claims you are on the latest.
    if (!opened) return "   - older version";

    return (
        `   - v${opened.version} ${formatDate(opened.created_at)}` +
        (selectedSolutionId === null ? " (latest)" : "")
    );
}

function formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    return `${String(date.getDate()).padStart(2, "0")} ${date.toLocaleString([], {
        month: "short",
    })} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * Point the reader at one solution, or back at whatever is latest.
 *
 * This reloads rather than just refetching: the document stream is subscribed
 * per solution (`?solution_id=`), so a pinned page would go on receiving events
 * about the solution it is pinned to and never learn that a newer one landed.
 */
function openSolution(id: number | null): void {
    if (selectedSolutionId === id) return;
    selectedSolutionId = id;
    void page.reload();
}

// ── the action menu ─────────────────────────────────────────────────────────

/**
 * Back leads, as on the assignment page: double-tap-tap still means "leave", so
 * the reflex from before the menu existed keeps working, and "solve again" is
 * something you travel to rather than something you land on.
 */
function buildMenu(): MenuEntry[] {
    return menuMode === "versions" ? buildVersionMenu() : buildRootMenu();
}

function buildRootMenu(): MenuEntry[] {
    const s = status();
    const items: MenuEntry[] = [{ label: "Back", run: leavePage }];

    if (requesting || s?.state === "queued" || s?.state === "solving") {
        items.push({ label: "Cancel this solve", run: cancelSolve });
    } else if (s?.state === "idle" || s?.state === "failed" || s?.state === "solved") {
        // Same as a tap, offered anyway: the menu is where you look when you
        // don't trust what a tap will do.
        items.push({ label: s.state === "solved" ? "Solve again" : "Solve now", run: solveNow });
    }

    // Only while it is not where you already are, so the top level stays short
    // for the case that is normal — nothing pinned, latest on screen.
    if (selectedSolutionId !== null) {
        items.push({ label: "Back to latest", run: () => openSolution(null) });
    }
    // One version is the one you are reading; there is nothing to pick between.
    if (history().length > 1) {
        items.push({ label: "Open a version...", run: () => openMenu("versions") });
    }
    return items;
}

/**
 * The picker. Every solution the server still holds, newest first, named by
 * when it was made — a re-solve of the same paper is distinguishable from the
 * one before it only by its timestamp, and often only by its minute.
 *
 * Longer than the panel is fine; the menu scrolls a window over it.
 */
function buildVersionMenu(): MenuEntry[] {
    const items: MenuEntry[] = [{ label: "Back", run: () => openMenu("root") }];
    const saved = history();

    for (const [index, item] of saved.entries()) {
        const newest = index === 0;
        // Newest counts as "where you are" when nothing is pinned, because that
        // is what an unpinned page is showing.
        const current = selectedSolutionId === null ? newest : selectedSolutionId === item.id;
        items.push({
            // No "(latest)" tag on the first one: `line()` mirrors this label
            // into the footer with its own "n/total  tap=ok" and the strip is
            // one line. The heading says which end of the list you start at.
            label: `${current ? "*" : " "}v${item.version} ${formatDate(item.created_at)}`,
            run: () => {
                menuMode = "root";
                // Picking the newest un-pins rather than pinning to its id, so
                // the page keeps following new solves instead of freezing on
                // what happened to be latest when you opened the menu.
                openSolution(newest ? null : item.id);
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

/** Why the entries are what they are — see the note in menu.ts. */
function menuHeading(): string {
    if (menuMode === "versions") return "VERSIONS - NEWEST FIRST";
    if (requestError) return "REQUEST FAILED";
    if (requesting) return "SOLVING - starting";
    // Which explains why the entries below lead with "Back to latest".
    if (selectedSolutionId !== null) {
        const opened = history().find((item) => item.id === selectedSolutionId);
        return opened ? `READING v${opened.version}` : "READING AN EARLIER ONE";
    }

    const s = status();
    if (!s) return "CONNECTING";
    switch (s.state) {
        case "no_assignment":
            return "NOTHING TO SOLVE";
        case "idle":
            return `READY - ${s.assignment.problems} problems`;
        case "queued":
        case "solving":
            return `SOLVING - ${elapsed(runElapsedMs())}`;
        case "failed":
            return "LAST SOLVE FAILED";
        case "solved":
            return s.solution?.stale ? "SOLVED - earlier scan" : "SOLVED";
    }
}

const menu = createMenu({
    name: "AI",
    containerID: DOC_MENU_ID,
    build: buildMenu,
    heading: menuHeading,
    enqueue: (task) => page.enqueue(task),
    onPaint: async () => {
        // The menu lands in the same rectangle as the button, so exactly one of
        // them may hold text. This runs on open, on every swipe and on close,
        // which is precisely when that can change.
        paintButton();
        await page.updatePager();
    },
    backdrop: {
        // Both directions are the same question — what should be covering the
        // document now? — and syncOverlay is the one place that answers it. The
        // menu opening does not mean the screen goes dark (it may want the
        // variant), and the menu closing does not mean the document comes back
        // (the button may still need the screen).
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

// ── the button ──────────────────────────────────────────────────────────────

const solveBox = createPanel({
    containerID: DOC_SOLVE_ID,
    name: "solve",
    rect: SOLVE_RECT,
    zOrderIndex: Z_SOLVE,
    enqueue: (task) => page.enqueue(task),
});

/**
 * Put whatever should be covering the document where it belongs — the only
 * writer, and it decides *inside* the page's write chain.
 *
 * Three cases, in priority order:
 *
 *   the button   black. It is modal, and not being able to read the solution
 *                you just asked to replace is the whole of what it says.
 *   the menu     the variant render: the document with a dark box where the
 *                panel goes, so the answer stays readable around the menu that
 *                is about it. Black only until that render arrives — a menu
 *                over an unmasked document is text on text.
 *   neither      the document comes back.
 *
 * That matters more than it looks. Deciding outside the chain means deciding from
 * a snapshot: two status events landing together (a finished solve sends the
 * document and the status at once) would queue "put the backdrop up" and then,
 * reading a flag the first task hadn't yet set, queue nothing to take it down.
 * The backdrop went up last and stayed there — a blank document with a perfectly
 * up-to-date pager over it, and no further event to fix it. On the glasses every
 * bridge write costs hundreds of milliseconds, so that window was wide open;
 * in a browser the queue drained first and it looked fine.
 *
 * `page.isMasked()` read here is the truth, and overlay/restore are cheap when
 * they have nothing to do.
 */
function syncOverlay(): void {
    void page.enqueue(async () => {
        if (!buttonUp() && !menu.isOpen()) {
            if (page.isMasked()) await page.restoreTiles();
            return;
        }
        if (replacingDocument()) {
            // Putting it up twice is free — the tiles dedup identical bytes —
            // so this needs no "already dark?" test of its own.
            await page.overlayTiles(backdrop());
            return;
        }
        if (!(await page.overlayVariant())) await page.overlayTiles(backdrop());
    });
}

/**
 * Whether what is on screen is about to be thrown away.
 *
 * Only a solve in flight is. It was tempting to say "the button is up, so black
 * out the document" — the button is modal, after all — but `idle` and `failed`
 * put the button up over a solution that is still perfectly good, and often the
 * very thing the button is talking about: "(shown: earlier scan)" is a sentence
 * about a document you were then prevented from seeing. Blacking those out also
 * meant the MENU came up black whenever the button was up, which is how this
 * was found.
 */
function replacingDocument(): boolean {
    if (requesting) return true;
    const s = status();
    return s?.state === "queued" || s?.state === "solving";
}

/** The box's text, and whatever is under it. */
function paintButton(): void {
    // The menu owns the rectangle while it is open; the button gets it back when
    // the menu closes (onPaint runs then too).
    solveBox.set(menu.isOpen() || !buttonUp() ? " " : buttonText());
    syncOverlay();
}

/** Repaint on a timer while a run is in flight, so the elapsed time moves. */
function syncTicker(): void {
    const s = status();
    const running = s?.state === "queued" || s?.state === "solving";
    if (running && !ticker) {
        ticker = setInterval(repaint, TICK_MS);
    } else if (!running && ticker) {
        clearInterval(ticker);
        ticker = null;
    }
}

// ── page ────────────────────────────────────────────────────────────────────

const page = createDocPage({
    name: "AI",
    base: DOC_BASE_SOLUTION,
    state: GlobalState.aiState,
    query: () => docQuery(),
    // The same document with the menu's rectangle reserved, so the menu can
    // open without taking the solution off the screen. See HUD_MENU.
    variantQuery: () => docQuery("overlay=menu"),
    // Tap presses the button when it's up; otherwise it turns the page. That
    // decision needs live state, so it is made in handleAiPageEvent rather than
    // fixed here.
    tapAction: "page",
    pagerLabel,
    // Polled when the stream drops. A finished solve is announced once, and
    // missing it is what leaves the page saying CLAUDE IS SOLVING forever.
    statusPath: `${SOLVE_BASE}/status`,
    events: {
        status: (data) => {
            const next = data as SolverStatus;
            GlobalState.solverStatus = next;
            // The local guess has done its job the moment the server accounts
            // for the request — or reports something that says it never will.
            // `solved` and `idle` are the two it can't distinguish from "your
            // tap hasn't been processed yet", so they don't clear it.
            if (requesting && next.state !== "solved" && next.state !== "idle") {
                setRequesting(false);
            }
            // A solve is about the paper in front of you, not the history you
            // were browsing: go back to following the live document, or the
            // answer will land on a page still pinned to an older one.
            if (next.state === "queued" || next.state === "solving") openSolution(null);
            statusReceivedAt = Date.now();
            syncTicker();
            repaint();
        },
    },
    // Tiles land on their own schedule — and a solve landing is exactly when the
    // button has to get out of the way.
    afterShow: async () => paintButton(),
});

/** The query for the document the reader is on: pinned, or whatever is latest. */
function docQuery(extra?: string): string {
    const parts: string[] = [];
    if (selectedSolutionId !== null) parts.push(`solution_id=${selectedSolutionId}`);
    if (extra) parts.push(extra);
    return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * Start a solve. Puts the button up before the request leaves, because the
 * round trip is long enough to read as nothing having happened — see
 * `requesting`.
 */
function solveNow(): void {
    // Whatever it produces will be the latest, so stop reading history now
    // rather than when it lands: this reloads the page onto the live document,
    // which is the stream the answer will arrive on.
    openSolution(null);
    requestError = null;
    setRequesting(true);
    repaint();
    void post("/solve", "Solving");
}

function cancelSolve(): void {
    requestError = null;
    setRequesting(false);
    repaint();
    // Said outright rather than left to the status event: cancelling a claimed
    // run is a round trip too, and the box would otherwise go on counting.
    solveBox.set("CANCELLING...");
    void post("/cancel", "Cancelling");
}

/**
 * Ask the server to start or abandon a solve. The reply only says whether the
 * request was accepted; the `status` event that follows is what the box shows,
 * so there is one source of truth for what is happening.
 */
async function post(path: string, working: string): Promise<void> {
    if (requestInFlight) return;
    requestInFlight = true;
    // No "Solving..." placeholder here: the callers have already put the right
    // thing on screen, and this used to overwrite it with a worse one.
    try {
        const res = await fetch(`${MARKDOWN_SERVER_URL}${SOLVE_BASE}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
        });
        const result = (await res.json()) as {
            ok: boolean;
            action?: string;
            detail?: string;
        };
        appLog("AI", path, result.action ?? "", result.detail ?? "");
        if (!result.ok) {
            // Answered, and the answer is no: drop the local guess that a solve
            // is starting, and keep the button up to say why.
            setRequesting(false);
            requestError = `Couldn't ${working.toLowerCase()}: ${result.detail ?? "refused"}`;
            repaint();
        } else if (result.action === "queued") {
            // Worth saying outright: the run is real, but nothing is working on
            // it yet, and the status event alone doesn't distinguish "starting"
            // from "waiting for a schedule".
            appLog("AI", "queued - no trigger configured:", result.detail ?? "");
        }
    } catch (err) {
        appLog("AI", path, "failed", err);
        setRequesting(false);
        requestError = "The document server is unreachable";
        repaint();
    } finally {
        requestInFlight = false;
        // The next `status` event repaints the box with the truth.
    }
}

/** The menu's "Back" entry — what a double tap used to do on its own. */
function leavePage(): void {
    leaveAiPage();
    navigateBack();
}

/** Called by main.ts after the AI page containers are built. */
export async function enterAiPage(): Promise<void> {
    // Guesses about a request made on a previous visit; the status stream is
    // about to say what is actually happening.
    menuMode = "root";
    setRequesting(false);
    requestError = null;
    // The containers are new and blank, so the box has to forget what it was
    // showing: the dedup would otherwise skip a repaint that says the same
    // thing the last visit ended on, and leave it empty. See Panel.reset().
    solveBox.reset();

    // Painted BEFORE the document loads, not after.
    //
    // Both writes go on the page's chain, and the order there is the order they
    // reach the glasses. Walk back onto this page while a solve is running and
    // the tiles from your last visit are still in `state`, so loading the
    // document first spends a four-tile BLE push drawing the solution you are
    // in the middle of replacing — and only then covers it with the backdrop
    // that says so. Queued ahead, the backdrop masks the page and showPage
    // skips the push entirely.
    paintButton();
    // page.enter() clears the overlay state itself — the containers are new, so
    // nothing can be covering anything.
    await page.enter();
}

/** Tear down live connections when leaving the page. */
export function leaveAiPage(): void {
    if (ticker) {
        clearInterval(ticker);
        ticker = null;
    }
    // No repaint: the containers are about to be torn down with the page.
    menu.close(false);
    page.leave();
}

export function handleAiPageEvent(gesture: GESTURE_EVENTS): void {
    if (menu.handleGesture(gesture)) return;

    // Double tap is the menu here, so it never reaches docPage's back gesture —
    // "Back" inside the menu is the way out of the page. Always at the top
    // level: a version picker left open from last time is not what a double tap
    // is asking for.
    if (gesture === GESTURE_EVENTS.DOUBLE_TAP) {
        openMenu("root");
        return;
    }

    // The button takes the tap while it's up. A tap that can't start anything
    // (already solving, nothing to solve) is swallowed rather than turning a page
    // nobody can see behind the backdrop.
    if (gesture === GESTURE_EVENTS.TAP && buttonUp()) {
        if (tappable()) solveNow();
        return;
    }

    page.handleGesture(gesture);
}
