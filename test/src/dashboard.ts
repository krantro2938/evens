import {
    DASHBOARD_SLEEP_MS,
    GESTURE_EVENTS,
    MENU_ITEMS,
    MenuItem,
    PAGES,
} from "./constants";
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
    Mine: PAGES.MINE,
    Msgs: PAGES.MESSAGES,
    Camera: PAGES.CAMERA,
    Setup: PAGES.SETTINGS,
};

// ── sleep ───────────────────────────────────────────────────────────────────
//
// The dashboard is where you stand when you are not doing anything, so it is
// the page that spends the most time lit in front of your eye saying nothing
// new. After DASHBOARD_SLEEP_MS of no gestures it draws NOTHING — the display
// is emissive, so an empty page is a dark one — and a double tap draws it back.
//
// Nothing is torn down: the focused tile, the unread count and the message
// stream are all untouched, and this is not a page in PAGES. It is the same
// dashboard with its tiles left off, which is why buildPage() checks it rather
// than a separate render path — every existing caller (a swipe, an arriving
// message) then keeps the screen dark instead of quietly lighting it up.
//
// WHILE DARK, ONLY THE DOUBLE TAP DOES ANYTHING. A single tap would otherwise
// open whichever page happened to be focused on a screen you cannot see, so
// taps and swipes are swallowed. The double tap costs the dashboard's exit
// gesture while it sleeps — see the DOUBLE_CLICK_EVENT case in main.ts, which
// prefers waking over quitting; double tap twice to leave.

let sleepTimer: ReturnType<typeof setTimeout> | null = null;
let asleep = false;

/** Whether the dashboard is currently drawing nothing. */
export function dashboardAsleep(): boolean {
    return asleep;
}

/** (Re)start the countdown. Called on every repaint of a lit dashboard. */
export function armDashboardSleep(): void {
    if (sleepTimer !== null) clearTimeout(sleepTimer);
    sleepTimer = setTimeout(() => {
        sleepTimer = null;
        void sleepDashboard();
    }, DASHBOARD_SLEEP_MS);
}

/** Leaving the dashboard: stop the timer, and come back lit. */
export function leaveDashboardPage(): void {
    if (sleepTimer !== null) clearTimeout(sleepTimer);
    sleepTimer = null;
    asleep = false;
}

async function sleepDashboard(): Promise<void> {
    // The timer outlives a navigation by up to one interval — a tap that opens
    // the AI page does not clear it before the page is built. Check where we
    // actually are rather than trusting the timer.
    if (asleep || GlobalState.currentPage !== PAGES.DASHBOARD) return;
    asleep = true;
    appLog("Dashboard sleep");
    await buildPage(PAGES.DASHBOARD);
}

async function wakeDashboard(): Promise<void> {
    if (!asleep) return;
    asleep = false;
    appLog("Dashboard wake");
    // Re-arms itself: buildPage arms the timer whenever it draws a lit one.
    await buildPage(PAGES.DASHBOARD);
}

export function handleDashboardEvent(gesture: GESTURE_EVENTS) {
    if (asleep) {
        // Swallow everything else. See the note above: acting on a page you
        // cannot see is worse than a gesture that appears to do nothing.
        if (gesture === GESTURE_EVENTS.DOUBLE_TAP) void wakeDashboard();
        return;
    }

    // Any gesture is activity, including one that changes nothing.
    armDashboardSleep();

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
