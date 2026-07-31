import { MenuItem, PAGES } from "./constants";
import type { TilePage } from "./render/tiles";

type DashboardState = {
    focusedItem: MenuItem;
};

/** What any server-rendered document page needs to draw itself. */
export type DocState = {
    pages: TilePage[];
    currentPage: number;
    /** Last rendered document version; -1 before first load. */
    version: number;
    /** Status shown in the pager while there are no pages yet. */
    status: string;
    /**
     * The host couldn't send the tiles to the glasses (`sendFailed`). The
     * document is fine and so are the containers — the BLE transfer isn't. Worth
     * saying out loud: the failure is silent and invisible otherwise, and looks
     * exactly like a rendering bug, since the pager keeps updating over a blank
     * panel.
     */
    linkError: boolean;
    /**
     * When the tiles on screen were cached, or null if they came off the
     * network. Set when the server was unreachable and the on-device cache
     * answered instead (see render/tileCache.ts).
     *
     * The footer says so. The tiles are never *wrong* — they are keyed by the
     * server's content hash — but "the assignment as it was three hours ago" is
     * a different claim from "the assignment", and a stale page that looks live
     * is the one failure this cache could introduce.
     */
    cachedAt: number | null;
};

/** Mirror of the server's `status` SSE payload (see server/assignment.ts). */
export type AssignmentStatus = {
    upstream: "disabled" | "connecting" | "open" | "error";
    running: boolean;
    done: boolean;
    captures: number;
    max_captures: number;
    reason: string | null;
    problems: number;
    /** Of those, how many the model says it has in full. */
    problems_complete: number;
    /** Whether any frame this attempt has shown the whole sheet. Rare and not
     *  required: the camera reads a sheet a piece at a time. */
    full_page_seen: boolean;
    /** Edges of the PAPER no frame has shown yet — the gate the reader puts on
     *  `done`, and the honest answer to "is this all of it". Empty means the
     *  scan has covered the sheet, however many frames that took. */
    edges_unseen: string[];
    /** Where the reader last asked the camera to point. */
    next_target: string;
    next_target_short?: string;
    feedback: {
        camera_advice: string;
        advice_detail: string;
        cut_off_edges: string[];
        frame_quality: string;
        confidence: number;
        /** The part of the sheet still wanted, in the model's words. */
        next_target: string;
        next_target_short?: string;
        region: string;
        more_content_beyond: string[];
    } | null;
    error: string | null;
    /** The reader's current attempt number; bumps on every reset. */
    version: number;
    /** Which scan the solve button sends to the AI, null while it follows the
     *  live one. Set from the version picker; a reset puts it back to null.
     *  Optional: a server too old to send it leaves the page on live, which is
     *  what it did before this existed. */
    active_version?: number | null;
    /** Every scan the reader still holds, newest first, live one at the head.
     *  What the version picker is built from — the assignment page's answer to
     *  the AI page's `solution_history`. */
    versions: Array<{
        version: number;
        created_at: string;
        updated_at: string;
        capture_count: number;
        done: boolean;
        problems: number;
        title: string;
        /** False for the attempt still in progress. */
        archived: boolean;
    }>;
    /** When the last capture landed, so the page can say how long ago. */
    last_capture_at: number | null;
};

/** Mirror of the server's AI-page `status` payload (see server/solver.ts). */
export type SolverStatus = {
    /** no_assignment | idle | queued | solving | solved | failed. `idle` and
     *  `failed` are what put the trigger button on screen. */
    state: "no_assignment" | "idle" | "queued" | "solving" | "solved" | "failed";
    assignment: {
        available: boolean;
        /** A content hash of the markdown being solved, NOT the reader's attempt
         *  number — `active_version` is the one a person can act on. */
        version: number | null;
        problems: number;
        /** The reader believes it has the whole page. */
        done: boolean;
        /** The scan the button would send, null while it follows the live one.
         *  Chosen on the Assignment page's version picker. */
        active_version?: number | null;
    };
    solution: {
        created_at: number;
        age_ms: number;
        model: string | null;
        assignment_version: number | null;
        /** What's displayed answers an EARLIER scan than the current paper. */
        stale: boolean;
        chars: number;
    } | null;
    run: {
        id: number;
        state: string;
        created_at: number;
        age_ms: number;
        claimed: boolean;
        /** triggered | unconfigured | failed — how the routine was (not) kicked. */
        trigger: string | null;
        trigger_detail: string | null;
        error: string | null;
    } | null;
    trigger: { configured: boolean; detail: string };
    solutions: number;
    /** The version picker's list, newest first. `version` counts from the
     *  first solution ever submitted, so it doesn't shift as new ones land. */
    solution_history: Array<{
        id: number;
        version: number;
        created_at: number;
        model: string | null;
        assignment_version: number | null;
        chars: number;
    }>;
};

const newDocState = (): DocState => ({
    pages: [],
    currentPage: 0,
    version: -1,
    status: "Loading...",
    linkError: false,
    cachedAt: null,
});

export class GLOBAL_STATE {
    dashboardState: DashboardState = {
        focusedItem: "AI",
    };
    aiState: DocState = newDocState();
    assignmentState: DocState = newDocState();
    /** The Adri page: a document you wrote yourself (see src/adri.ts). */
    adriState: DocState = newDocState();
    /** The Mine page: your own answer to the scan (see src/mine.ts). */
    mineState: DocState = newDocState();
    /** Live job/camera state from the reader; null until the first `status`. */
    assignmentStatus: AssignmentStatus | null = null;
    /** Live solve state for the AI page; null until the first `status`. */
    solverStatus: SolverStatus | null = null;
    currentPage: PAGES = PAGES.DASHBOARD;
    /**
     * Messages sent from the web app that the glasses have not drawn yet.
     *
     * Lives here rather than in messages.ts because the dashboard draws it into
     * the Msgs tile, and that count IS the notification indicator — no document
     * page reserves pixels for one.
     */
    unreadMessages = 0;

    constructor() {}

    setDashboardFocusedItem(item: MenuItem) {
        this.dashboardState.focusedItem = item;
    }
}

export const GlobalState = new GLOBAL_STATE();
