import { MenuItem, PAGES } from "./constants";

type DashboardState = {
    focusedItem: MenuItem;
};

export class GLOBAL_STATE {
    dashboardState: DashboardState = {
        focusedItem: "AI",
    };
    currentPage: PAGES = PAGES.DASHBOARD;

    constructor() {}

    setDashboardFocusedItem(item: MenuItem) {
        this.dashboardState.focusedItem = item;
    }
}

export const GlobalState = new GLOBAL_STATE();
