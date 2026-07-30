import {
    waitForEvenAppBridge,
    TextContainerProperty,
    ImageContainerProperty,
    CreateStartUpPageContainer,
    RebuildPageContainer,
    OsEventTypeList,
    validateEvenHubPageContainerZOrder,
    formatEvenHubPageContainerValidationError,
} from "@evenrealities/even_hub_sdk";
import {
    BODY_H,
    BODY_RADIUS,
    BODY_W,
    CONTAINER_PAD,
    dashboardRects,
    DEFAULT_COLOR,
    DOC_EVENT_LAYER_ID,
    DOC_FEEDBACK_ID,
    DOC_MENU_ID,
    DOC_PAGER_H,
    DOC_PAGER_ID,
    DOC_PAGER_Y,
    DOC_SOLVE_ID,
    DOC_TILE_IDS,
    FOCUSED_COLOR,
    GESTURE_EVENTS,
    HUD_FEEDBACK_RECT,
    IMAGE_PAYLOAD,
    MENU_ITEMS,
    PAGES,
    SETTINGS_ID,
    SOLVE_RECT,
    TILE_H,
    TILE_W,
    Z_BACKDROP,
    Z_FEEDBACK,
    Z_PAGER,
    Z_SOLVE,
    Z_TILE_BASE,
    Z_ORDER_ENABLED,
    zOrder,
} from "./constants";
import { GlobalState } from "./state";
import { handleDashboardEvent } from "./dashboard";
import {
    buildMessagesPage,
    handleMessagesPageEvent,
    leaveMessagesPage,
    startMessageStream,
} from "./messages";
import { stringToShortId } from "./utils";
import { enterAiPage, handleAiPageEvent, leaveAiPage } from "./ai";
import {
    enterAssignmentPage,
    handleAssignmentPageEvent,
    leaveAssignmentPage,
} from "./assignment";
import {
    enterCameraPage,
    handleCameraPageEvent,
    leaveCameraPage,
} from "./camera";
import {
    enterSettingsPage,
    handleSettingsPageEvent,
    leaveSettingsPage,
} from "./settings";
import { enterAdriPage, handleAdriPageEvent, leaveAdriPage } from "./adri";
import { enterMinePage, handleMinePageEvent, leaveMinePage } from "./mine";
import { tileLayout } from "./render/tiles";
import { menuContainer } from "./menu";
import { panelContainer } from "./panel";
import { appLog } from "./debug";
import { mountCompanion } from "./companion";

// The companion app goes up FIRST, before the bridge is waited on.
//
// waitForEvenAppBridge() is a top-level await, and in a plain browser — no Even
// Hub host, no simulator — it never resolves. Everything below it is then dead
// code, which is fine for the glasses and fatal for the phone screen: the tab
// where you upload a photo and type a solution would be a permanent "Starting…"
// on exactly the devices most likely to open it.
//
// So the companion is mounted synchronously and knows nothing about the bridge.
// It talks to the document server over HTTP like any other client.
const companionHost = document.getElementById("app");
if (companionHost) mountCompanion(companionHost);

// Wait for the bridge to be ready before doing anything else.
// In the simulator this resolves immediately; on hardware it waits
// for the WebView to initialize the SDK bridge.
export const bridge = await waitForEvenAppBridge();

// Keep one full-screen event target behind the visual dashboard tiles.
const main = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 0,
    borderColor: 5,
    // borderRadius: 20,
    // paddingLength: 4,
    containerID: 1,
    containerName: "main",
    content: " ",
    isEventCapture: 1, // ← receive click events on this container
    ...zOrder(Z_BACKDROP),
});

function createDashboardTiles() {
    const rects = dashboardRects();
    return MENU_ITEMS.map((item, index) => {
        const rect = rects[index];
        const isItemFocused = GlobalState.dashboardState.focusedItem === item;

        return new TextContainerProperty({
            xPosition: rect.x,
            yPosition: rect.y,
            width: rect.w,
            height: rect.h,
            borderWidth: 2,
            borderColor: isItemFocused ? FOCUSED_COLOR : DEFAULT_COLOR,
            borderRadius: BODY_RADIUS,
            paddingLength: CONTAINER_PAD,
            containerID: stringToShortId(item),
            containerName: item,
            // The Msgs tile carries the unread count. This is the app's only
            // notification indicator: a document page has no spare layer to put
            // one on (see messages.ts), and a tile you already walk past on the
            // way to everything else is a better home for it than a permanent
            // hole in every rendered document.
            content:
                item === "Msgs" && GlobalState.unreadMessages > 0
                    ? `${item} ${GlobalState.unreadMessages}`
                    : item,
            isEventCapture: 0,
            ...zOrder(Z_TILE_BASE + index),
        });
    });
}

const dashboardTiles = createDashboardTiles();

// Render the page. `result` is 0 on success.
const startUpPage = new CreateStartUpPageContainer({
    containerTotalNum: dashboardTiles.length + 1,
    textObject: [main, ...dashboardTiles],
});

// The dashboard's containers don't overlap, so their order is irrelevant — but
// z-order is all-or-nothing, and a page that skips it once the app has used it
// elsewhere is the sort of inconsistency that shows up as a blank panel.
const startUpZ = validateEvenHubPageContainerZOrder(startUpPage);
if (!startUpZ.valid) {
    appLog("Z-ORDER INVALID (dashboard)", formatEvenHubPageContainerValidationError(startUpZ));
}

const result = await bridge.createStartUpPageContainer(startUpPage);

if (result !== 0) {
    console.error("createStartUpPageContainer failed:", result);
    appLog("createStartUpPageContainer failed:", result);
    // 1 = invalid params, 2 = oversize, 3 = out of memory
}

// Opened here rather than by the Messages page, and never closed. A message has
// to reach you on whichever page you are standing on, so this is the one stream
// in the app that outlives navigation — everything else in docPage.ts is
// deliberately torn down when you walk away from it.
startMessageStream();

// Which build is on the glasses, in the log the glasses can actually send. The
// z-order mode is the first thing to know when tiles stop arriving.
appLog(
    "Dashboard created",
    result,
    "| z-order",
    Z_ORDER_ENABLED ? "on" : "OFF",
    "| image payload",
    IMAGE_PAYLOAD,
);

// Single event subscription - all OS events arrive through onEvenHubEvent.
// Tap and double-tap events typically arrive through sysEvent; textEvent is
// used for text/scroll interactions.
// let count = 0;

bridge.onEvenHubEvent((event) => {
    const sysEvent = event.sysEvent;
    const textEvent = event.textEvent;

    const eventType = sysEvent?.eventType ?? textEvent?.eventType ?? undefined;
    appLog(
        "event",
        eventType ?? "undefined",
        "page",
        PAGES[GlobalState.currentPage],
    );

    switch (eventType) {
        case OsEventTypeList.CLICK_EVENT:
        case undefined: // SDK/protobuf may omit zero-valued enum fields.
            // count += 1;
            // bridge.textContainerUpgrade(
            //     new TextContainerUpgrade({
            //         containerID: 1,
            //         containerName: "main",
            //         content: `Hello from G2!\n\nTap to count: ${count}\nDouble-tap to exit`,
            //     }),
            // );
            handleGestureEvent(GESTURE_EVENTS.TAP);
            break;

        case OsEventTypeList.SCROLL_TOP_EVENT:
            handleGestureEvent(GESTURE_EVENTS.SWIPE_UP);
            break;

        case OsEventTypeList.SCROLL_BOTTOM_EVENT:
            handleGestureEvent(GESTURE_EVENTS.SWIPE_DOWN);
            break;

        case OsEventTypeList.DOUBLE_CLICK_EVENT:
            // Mode 1 shows the system exit-confirmation dialog -
            // required on the root page; silent exit (mode 0) is rejected in QA.

            if (GlobalState.currentPage !== PAGES.DASHBOARD) {
                appLog("Back gesture");
                handleGestureEvent(GESTURE_EVENTS.DOUBLE_TAP);
                break;
            }

            appLog("Exit gesture");
            leaveCurrentPage();
            bridge.shutDownPageContainer(1);
            break;

        case OsEventTypeList.SYSTEM_EXIT_EVENT:
        case OsEventTypeList.ABNORMAL_EXIT_EVENT:
            leaveCurrentPage();
            break;
    }
});

// The dashboard was already rendered by createStartUpPageContainer.

function handleGestureEvent(gesture: GESTURE_EVENTS) {
    switch (GlobalState.currentPage) {
        case PAGES.DASHBOARD:
            handleDashboardEvent(gesture);
            break;
        case PAGES.AI:
            handleAiPageEvent(gesture);
            break;
        case PAGES.ASSIGNMENT:
            handleAssignmentPageEvent(gesture);
            break;
        case PAGES.CAMERA:
            handleCameraPageEvent(gesture);
            break;
        case PAGES.SETTINGS:
            handleSettingsPageEvent(gesture);
            break;
        case PAGES.ADRI:
            handleAdriPageEvent(gesture);
            break;
        case PAGES.MINE:
            handleMinePageEvent(gesture);
            break;
        case PAGES.MESSAGES:
            handleMessagesPageEvent(gesture);
            break;
        // A default rather than a named case per page: whatever page gets added
        // next should be escapable before it is finished, not after. Adri was a
        // placeholder whose own text said "Double click to go back" while no
        // case here handled the gesture, so the page was a dead end you had to
        // restart out of.
        default:
            if (gesture === GESTURE_EVENTS.DOUBLE_TAP) navigateBack();
            break;
    }
}

// Document pages hold an SSE connection and a poll timer; leaving one without
// tearing those down leaks a live stream per visit.
function leaveCurrentPage() {
    switch (GlobalState.currentPage) {
        case PAGES.AI:
            leaveAiPage();
            break;
        case PAGES.ASSIGNMENT:
            leaveAssignmentPage();
            break;
        case PAGES.CAMERA:
            leaveCameraPage();
            break;
        case PAGES.SETTINGS:
            leaveSettingsPage();
            break;
        case PAGES.ADRI:
            leaveAdriPage();
            break;
        case PAGES.MINE:
            leaveMinePage();
            break;
        case PAGES.MESSAGES:
            leaveMessagesPage();
            break;
    }
}

/** What a document page adds on top of tiles + gesture layer + pager. */
interface DocumentPageExtras {
    /** Assignment: the camera-advice panel, backed by a server-reserved rect. */
    feedback?: boolean;
    /** AI: the solve trigger / progress box, over the menu's backdrop. */
    solve?: boolean;
    /** The centred action menu. Both pages have one. */
    menu?: boolean;
}

// The container layout shared by every document page: a 2×2 grid of image
// tiles, a gesture-capturing layer behind them, and a footer pager. Each page
// adds its own overlay containers — declared here rather than created on demand,
// because border width and geometry are fixed when the page is built.
async function buildDocumentPage(extras: DocumentPageExtras = {}) {
    // Full-screen transparent text layer receives the temple gestures
    // (image containers can't capture events).
    const eventLayer = new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: BODY_W,
        height: BODY_H,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: 0,
        containerID: DOC_EVENT_LAYER_ID,
        containerName: "docEvent",
        content: " ",
        isEventCapture: 1,
        ...zOrder(Z_BACKDROP),
    });

    const pager = new TextContainerProperty({
        xPosition: 0,
        yPosition: DOC_PAGER_Y,
        width: BODY_W,
        height: DOC_PAGER_H,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 4,
        containerID: DOC_PAGER_ID,
        containerName: "pager",
        content: "Loading...",
        isEventCapture: 0,
        ...zOrder(Z_PAGER),
    });

    const textObject = [eventLayer, pager];

    if (extras.feedback) {
        // Camera advice. Its dark background and frame are baked into the
        // assignment's tiles by the server (see panel.ts), so this is text only.
        textObject.push(
            panelContainer({
                containerID: DOC_FEEDBACK_ID,
                name: "feedback",
                rect: HUD_FEEDBACK_RECT,
                zOrderIndex: Z_FEEDBACK,
            }),
        );
    }

    if (extras.solve) {
        // The solve button. Blank until there is something to say, and its frame
        // comes from the menu's backdrop rather than a border — it occupies the
        // menu's rectangle for exactly that reason (see SOLVE_RECT).
        textObject.push(
            panelContainer({
                containerID: DOC_SOLVE_ID,
                name: "solve",
                rect: SOLVE_RECT,
                zOrderIndex: Z_SOLVE,
                padding: CONTAINER_PAD,
            }),
        );
    }

    if (extras.menu) {
        // The action menu, blank until a double tap fills it. See menu.ts for
        // why it is declared here rather than created on demand.
        textObject.push(menuContainer(DOC_MENU_ID));
    }

    // Four image tiles form the 2×2 grid the document renders into.
    const tiles = tileLayout().map(
        (t) =>
            new ImageContainerProperty({
                xPosition: t.x,
                yPosition: t.y,
                width: TILE_W,
                height: TILE_H,
                containerID: DOC_TILE_IDS[t.index],
                containerName: `tile${t.index}`,
                ...zOrder(Z_TILE_BASE + t.index),
            }),
    );

    const payload = new RebuildPageContainer({
        containerTotalNum: textObject.length + tiles.length,
        textObject,
        imageObject: tiles,
    });

    // z-order is all-or-nothing and must be unique across the page. Getting it
    // wrong is silent at the bridge, so check before sending: a page that
    // reverts to declaration-order stacking puts the image tiles back on top of
    // the menu, which is the bug this whole mechanism exists to fix.
    const zCheck = validateEvenHubPageContainerZOrder(payload);
    if (!zCheck.valid) {
        appLog("Z-ORDER INVALID", formatEvenHubPageContainerValidationError(zCheck));
    }

    // SDK limits: containerTotalNum 1~12, textObject <= 8, imageObject <= 4.
    // A rejected rebuild leaves the PREVIOUS page's containers in place, so the
    // symptom is a page that half works — old containers still update, new ones
    // silently don't exist.
    const built = await bridge.rebuildPageContainer(payload);
    appLog(
        "Document page rebuild",
        built ? "ok" : "FAILED",
        `${textObject.length} text + ${tiles.length} image`,
    );
}

export async function buildPage(page: PAGES) {
    appLog("Render page", PAGES[page]);
    switch (page) {
        case PAGES.DASHBOARD:
            // createDashboardTiles() rebuilds from focus state, so this carries
            // the same z-order the start-up page did — see Z_BACKDROP.
            const dashboard = new RebuildPageContainer({
                containerTotalNum: dashboardTiles.length + 1,
                textObject: [main, ...createDashboardTiles()],
            });
            const dashZ = validateEvenHubPageContainerZOrder(dashboard);
            if (!dashZ.valid) {
                appLog(
                    "Z-ORDER INVALID (dashboard)",
                    formatEvenHubPageContainerValidationError(dashZ),
                );
            }
            const rebuilt = await bridge.rebuildPageContainer(dashboard);
            if (!rebuilt) appLog("Dashboard rebuild failed");
            break;

        case PAGES.AI:
            await buildDocumentPage({ solve: true, menu: true });
            await enterAiPage();
            break;

        // No feedback box: the Assignment page is purely a reader now, and its
        // corner box was a permanent hole in the transcription repeating what
        // the footer already says. The CAMERA page keeps its box — that one
        // carries live camera advice, which is the thing you act on.
        case PAGES.ASSIGNMENT:
            await buildDocumentPage({ menu: true });
            await enterAssignmentPage();
            break;

        // A plain reader: no feedback box, no solve button, and no menu — there
        // is one Adri document and nothing on this page acts on it.
        case PAGES.ADRI:
            await buildDocumentPage();
            await enterAdriPage();
            break;

        // Likewise a plain reader — your own answer, typed on the phone. The AI
        // page keeps the solve button; nothing on this page acts on anything.
        case PAGES.MINE:
            await buildDocumentPage();
            await enterMinePage();
            break;

        // Same containers as a document page: the preview lands in the four
        // image tiles, the advice box keeps its reserved corner (the server
        // bakes that rect into the camera tiles too) and the menu carries the
        // controls that used to be on the assignment page.
        case PAGES.CAMERA:
            await buildDocumentPage({ feedback: true, menu: true });
            await enterCameraPage();
            break;

        // One full-screen text container and nothing else: this page has a
        // single sentence to say and a single (destructive) action, so there is
        // nothing to lay out and nothing to stack. See settings.ts.
        case PAGES.SETTINGS:
            await bridge.rebuildPageContainer(
                new RebuildPageContainer({
                    containerTotalNum: 1,
                    textObject: [
                        new TextContainerProperty({
                            xPosition: 0,
                            yPosition: 0,
                            width: BODY_W,
                            height: BODY_H,
                            borderWidth: 0,
                            borderColor: 5,
                            paddingLength: CONTAINER_PAD,
                            containerID: SETTINGS_ID,
                            containerName: "settings",
                            content: " ",
                            isEventCapture: 1,
                            ...zOrder(Z_BACKDROP),
                        }),
                    ],
                }),
            );
            await enterSettingsPage();
            break;

        // The one page whose containers this function does not know. A bubble
        // is sized to its own message and placed on the side that sent it, so
        // how many containers there are and where they sit is a property of the
        // conversation — the page builds itself. See messages.ts.
        case PAGES.MESSAGES:
            await buildMessagesPage();
            break;

        default:
            const text = new TextContainerProperty({
                xPosition: 0,
                yPosition: 0,
                width: 576,
                height: 288,
                borderWidth: 2,
                borderColor: 5,
                borderRadius: 20,
                // paddingLength: 4,
                containerID: 1,
                containerName: "main",
                content:
                    "Currently this page is absent \n\n Double click to go back",
                isEventCapture: 1, // ← receive click events on this container
                ...zOrder(Z_BACKDROP),
            });

            await bridge.rebuildPageContainer(
                new RebuildPageContainer({
                    containerTotalNum: 1,
                    textObject: [text],
                }),
            );
    }
}

export function navigate(page: PAGES) {
    if (GlobalState.currentPage !== page) leaveCurrentPage();
    GlobalState.currentPage = page;
    appLog("Navigate to", PAGES[page]);
    void buildPage(page).catch((error) => appLog("Page render failed", error));
}

export function navigateBack() {
    appLog("Navigate back to dashboard");
    switch (GlobalState.currentPage) {
        default:
            navigate(PAGES.DASHBOARD);
            GlobalState.currentPage = PAGES.DASHBOARD;
    }
}
