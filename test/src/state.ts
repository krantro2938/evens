import { MenuItem, PAGES } from "./constants";
import type { TilePage } from "./render/rasterize";

type DashboardState = {
    focusedItem: MenuItem;
};

type AiState = {
    pages: TilePage[];
    currentPage: number;
    /** Last rendered markdown version (file mtime); -1 before first load. */
    version: number;
    /** Status shown in the pager while there are no pages yet. */
    status: string;
};

export class GLOBAL_STATE {
    dashboardState: DashboardState = {
        focusedItem: "AI",
    };
    aiState: AiState = {
        pages: [],
        currentPage: 0,
        version: -1,
        status: "Loading…",
    };
    currentPage: PAGES = PAGES.DASHBOARD;

    constructor() {}

    setDashboardFocusedItem(item: MenuItem) {
        this.dashboardState.focusedItem = item;
    }
}

export const GlobalState = new GLOBAL_STATE();
