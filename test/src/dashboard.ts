import { GESTURE_EVENTS, MENU_ITEMS, MenuItem, PAGES } from "./constants";
import { buildPage, navigate } from "./main";
import { GlobalState } from "./state";
import { appLog } from "./debug";

/**
 * Where each tile goes. A map rather than a switch so adding a tile to
 * MENU_ITEMS without a destination is a type error here, instead of a tile that
 * silently does nothing when you tap it.
 */
const DESTINATIONS: Record<MenuItem, PAGES> = {
    AI: PAGES.AI,
    Assign: PAGES.ASSIGNMENT,
    Adri: PAGES.ADRI,
    Yula: PAGES.YULA,
    Camera: PAGES.CAMERA,
};

export function handleDashboardEvent(gesture: GESTURE_EVENTS) {
    const prevIndex = MENU_ITEMS.indexOf(
        GlobalState.dashboardState.focusedItem,
    );

    switch (gesture) {
        case GESTURE_EVENTS.TAP:
            appLog("Dashboard tap", GlobalState.dashboardState.focusedItem);
            navigate(DESTINATIONS[GlobalState.dashboardState.focusedItem]);
            break;

        case GESTURE_EVENTS.SWIPE_UP:
            const nextUpIndex =
                (prevIndex - 1 + MENU_ITEMS.length) % MENU_ITEMS.length;
            GlobalState.setDashboardFocusedItem(MENU_ITEMS[nextUpIndex]);
            void changeFocusedItem(
                MENU_ITEMS[prevIndex],
                MENU_ITEMS[nextUpIndex],
            );
            break;

        case GESTURE_EVENTS.SWIPE_DOWN:
            const nextDownIndex = (prevIndex + 1) % MENU_ITEMS.length;
            GlobalState.setDashboardFocusedItem(MENU_ITEMS[nextDownIndex]);
            void changeFocusedItem(
                MENU_ITEMS[prevIndex],
                MENU_ITEMS[nextDownIndex],
            );
            break;
    }
}

async function changeFocusedItem(_prevItem: MenuItem, _newItem: MenuItem) {
    // Border properties are part of the page definition, so refresh the page
    // instead of sending a text-only container upgrade.
    appLog("Dashboard focus", GlobalState.dashboardState.focusedItem);
    await buildPage(PAGES.DASHBOARD);
}
