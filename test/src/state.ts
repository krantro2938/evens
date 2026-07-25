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

const newDocState = (): DocState => ({
    pages: [],
    currentPage: 0,
    version: -1,
    status: "Loading…",
});

export class GLOBAL_STATE {
    dashboardState: DashboardState = {
        focusedItem: "AI",
    };
    aiState: DocState = newDocState();
    assignmentState: DocState = newDocState();
    /** Live job/camera state from the reader; null until the first `status`. */
    assignmentStatus: AssignmentStatus | null = null;
    currentPage: PAGES = PAGES.DASHBOARD;

    constructor() {}

    setDashboardFocusedItem(item: MenuItem) {
        this.dashboardState.focusedItem = item;
    }
}

export const GlobalState = new GLOBAL_STATE();
