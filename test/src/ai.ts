// The AI page: the solution to the assignment on the paper in front of you —
// and, when there isn't one yet, the button that goes and gets it.
//
//   tap         turn the page, or press the button when it's up
//   swipe       page through the solution
//   double tap  open the action menu (solve again, cancel, back)
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
// somebody else's algebra.

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

// Progress is the one thing the server can't push often enough — a queued run
// sends no events at all while it waits for the agent to pick it up. So the
// elapsed time is counted locally from the last status we saw.
let statusReceivedAt = 0;
let ticker: ReturnType<typeof setInterval> | null = null;
const TICK_MS = 5_000;

function status(): SolverStatus | null {
    return GlobalState.solverStatus;
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
    const s = status();
    if (!s) return false; // pre-connection: don't flash a button we can't press
    return s.state !== "solved";
}

/** Whether a tap on the button would actually start something. */
function tappable(): boolean {
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
        case "solved": {
            if (!state.pages.length) return state.status;
            const pages = `${state.currentPage + 1} / ${state.pages.length}`;
            return s.solution
                ? `${pages}  -  solved ${elapsed(s.solution.age_ms)} ago`
                : pages;
        }
    }
}

// ── the action menu ─────────────────────────────────────────────────────────

/**
 * Back leads, as on the assignment page: double-tap-tap still means "leave", so
 * the reflex from before the menu existed keeps working, and "solve again" is
 * something you travel to rather than something you land on.
 */
function buildMenu(): MenuEntry[] {
    const s = status();
    const items: MenuEntry[] = [{ label: "Back", run: leavePage }];

    if (s?.state === "queued" || s?.state === "solving") {
        items.push({ label: "Cancel this solve", run: () => post("/cancel", "Cancelling") });
    } else if (s?.state === "solved") {
        items.push({ label: "Solve again", run: () => post("/solve", "Solving") });
    } else if (s?.state === "idle" || s?.state === "failed") {
        // Same as a tap, offered anyway: the menu is where you look when you
        // don't trust what a tap will do.
        items.push({ label: "Solve now", run: () => post("/solve", "Solving") });
    }

    items.push({ label: "Close", run: () => {} });
    return items;
}

/** Why the entries are what they are — see the note in menu.ts. */
function menuHeading(): string {
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
        // Putting it up twice is free — the tiles dedup identical bytes — so this
        // needs no "already dark?" test of its own.
        show: (tiles) => page.overlayTiles(tiles),
        // Taking it down while the button still needs it would restore the
        // document under a button that is still on screen.
        hide: () => (buttonUp() ? Promise.resolve() : page.restoreTiles()),
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
 * Put the backdrop where it belongs — the only writer, and it decides *inside*
 * the page's write chain.
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
function syncBackdrop(): void {
    void page.enqueue(async () => {
        const wanted = buttonUp();
        if (wanted && !page.isMasked()) await page.overlayTiles(backdrop());
        else if (!wanted && page.isMasked() && !menu.isOpen()) {
            await page.restoreTiles();
        }
    });
}

/** The box's text, and the backdrop under it. */
function paintButton(): void {
    // The menu owns the rectangle while it is open; the button gets it back when
    // the menu closes (onPaint runs then too).
    solveBox.set(menu.isOpen() || !buttonUp() ? " " : buttonText());
    syncBackdrop();
}

/** Repaint on a timer while a run is in flight, so the elapsed time moves. */
function syncTicker(): void {
    const s = status();
    const running = s?.state === "queued" || s?.state === "solving";
    if (running && !ticker) {
        ticker = setInterval(() => {
            paintButton();
            void page.enqueue(() => page.updatePager());
        }, TICK_MS);
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
    // Tap presses the button when it's up; otherwise it turns the page. That
    // decision needs live state, so it is made in handleAiPageEvent rather than
    // fixed here.
    tapAction: "page",
    pagerLabel,
    events: {
        status: (data) => {
            GlobalState.solverStatus = data as SolverStatus;
            statusReceivedAt = Date.now();
            syncTicker();
            paintButton();
            page.enqueue(() => page.updatePager());
        },
    },
    // Tiles land on their own schedule — and a solve landing is exactly when the
    // button has to get out of the way.
    afterShow: async () => paintButton(),
});

/**
 * Ask the server to start or abandon a solve. The reply only says whether the
 * request was accepted; the `status` event that follows is what the box shows,
 * so there is one source of truth for what is happening.
 */
async function post(path: string, working: string): Promise<void> {
    if (requestInFlight) return;
    requestInFlight = true;
    solveBox.set(`${working}...`);
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
            solveBox.set(
                [
                    `Couldn't ${working.toLowerCase()}`,
                    "",
                    (result.detail ?? "").slice(0, 80),
                    "",
                    "TAP TO RETRY",
                ].join("\n"),
            );
        } else if (result.action === "queued") {
            // Worth saying outright: the run is real, but nothing is working on
            // it yet, and the status event alone doesn't distinguish "starting"
            // from "waiting for a schedule".
            appLog("AI", "queued - no trigger configured:", result.detail ?? "");
        }
    } catch (err) {
        appLog("AI", path, "failed", err);
        solveBox.set("Server unreachable\n\nTAP TO RETRY");
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
    // page.enter() clears the overlay state itself — the containers are new, so
    // nothing can be covering anything.
    await page.enter();
    paintButton();
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
    // "Back" inside the menu is the way out of the page.
    if (gesture === GESTURE_EVENTS.DOUBLE_TAP) {
        menu.open();
        return;
    }

    // The button takes the tap while it's up. A tap that can't start anything
    // (already solving, nothing to solve) is swallowed rather than turning a page
    // nobody can see behind the backdrop.
    if (gesture === GESTURE_EVENTS.TAP && buttonUp()) {
        if (tappable()) void post("/solve", "Solving");
        return;
    }

    page.handleGesture(gesture);
}
