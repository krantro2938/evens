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
    feedback: {
        camera_advice: string;
        advice_detail: string;
        cut_off_edges: string[];
        frame_quality: string;
        confidence: number;
    } | null;
    error: string | null;
};

/** Mirror of the server's AI-page `status` payload (see server/solver.ts). */
export type SolverStatus = {
    /** no_assignment | idle | queued | solving | solved | failed. `idle` and
     *  `failed` are what put the trigger button on screen. */
    state: "no_assignment" | "idle" | "queued" | "solving" | "solved" | "failed";
    assignment: {
        available: boolean;
        version: number | null;
        problems: number;
        /** The reader believes it has the whole page. */
        done: boolean;
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
};

const newDocState = (): DocState => ({
    pages: [],
    currentPage: 0,
    version: -1,
    status: "Loading...",
    linkError: false,
});

export class GLOBAL_STATE {
    dashboardState: DashboardState = {
        focusedItem: "AI",
    };
    aiState: DocState = newDocState();
    assignmentState: DocState = newDocState();
    /** Live job/camera state from the reader; null until the first `status`. */
    assignmentStatus: AssignmentStatus | null = null;
    /** Live solve state for the AI page; null until the first `status`. */
    solverStatus: SolverStatus | null = null;
    currentPage: PAGES = PAGES.DASHBOARD;

    constructor() {}

    setDashboardFocusedItem(item: MenuItem) {
        this.dashboardState.focusedItem = item;
    }
}

export const GlobalState = new GLOBAL_STATE();
