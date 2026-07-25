import {
    waitForEvenAppBridge,
    TextContainerProperty,
    ImageContainerProperty,
    CreateStartUpPageContainer,
    RebuildPageContainer,
    OsEventTypeList,
} from "@evenrealities/even_hub_sdk";
import {
    BODY_H,
    BODY_PAD,
    BODY_RADIUS,
    BODY_W,
    CONTAINER_PAD,
    DEFAULT_COLOR,
    DOC_EVENT_LAYER_ID,
    DOC_FEEDBACK_ID,
    DOC_PAGER_H,
    DOC_PAGER_ID,
    DOC_PAGER_Y,
    DOC_TILE_IDS,
    FEEDBACK_H,
    FEEDBACK_W,
    FEEDBACK_X,
    FEEDBACK_Y,
    FOCUSED_COLOR,
    GESTURE_EVENTS,
    MENU_ITEMS,
    PAGES,
    TILE_H,
    TILE_W,
} from "./constants";
import { GlobalState } from "./state";
import { handleDashboardEvent } from "./dashboard";
import { stringToShortId } from "./utils";
import { enterAiPage, handleAiPageEvent, leaveAiPage } from "./ai";
import {
    enterAssignmentPage,
    handleAssignmentPageEvent,
    leaveAssignmentPage,
} from "./assignment";
import { tileLayout } from "./render/tiles";
import { appLog } from "./debug";

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
});

function createDashboardTiles() {
    return MENU_ITEMS.map((item, index) => {
        const rest = index % 2;
        const whole = Math.floor(index / 2);
        const isItemFocused = GlobalState.dashboardState.focusedItem === item;

        return new TextContainerProperty({
            xPosition: rest * (BODY_W / 2) + rest * (BODY_PAD / 2),
            yPosition: whole * (BODY_H / 2) + whole * (BODY_PAD / 2),
            width: BODY_W / 2 - BODY_PAD / 2,
            height: BODY_H / 2 - BODY_PAD / 2,
            borderWidth: 2,
            borderColor: isItemFocused ? FOCUSED_COLOR : DEFAULT_COLOR,
            borderRadius: BODY_RADIUS,
            paddingLength: CONTAINER_PAD,
            containerID: stringToShortId(item),
            containerName: item,
            content: item,
            isEventCapture: 0,
        });
    });
}

const dashboardTiles = createDashboardTiles();

// Render the page. `result` is 0 on success.
const result = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
        containerTotalNum: dashboardTiles.length + 1,
        textObject: [main, ...dashboardTiles],
    }),
);

if (result !== 0) {
    console.error("createStartUpPageContainer failed:", result);
    appLog("createStartUpPageContainer failed:", result);
    // 1 = invalid params, 2 = oversize, 3 = out of memory
}

appLog("Dashboard created", result);

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
    }
}

// The container layout shared by every document page: a 2×2 grid of image
// tiles, a gesture-capturing layer behind them, and a footer pager. The
// assignment page adds a bordered corner box for camera advice / start-stop.
async function buildDocumentPage(withFeedback: boolean) {
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
        content: "Loading…",
        isEventCapture: 0,
    });

    const textObject = [eventLayer, pager];

    if (withFeedback) {
        textObject.push(
            new TextContainerProperty({
                xPosition: FEEDBACK_X,
                yPosition: FEEDBACK_Y,
                width: FEEDBACK_W,
                height: FEEDBACK_H,
                borderWidth: 2,
                borderColor: FOCUSED_COLOR,
                borderRadius: BODY_RADIUS,
                paddingLength: 6,
                containerID: DOC_FEEDBACK_ID,
                containerName: "feedback",
                content: "Connecting…",
                isEventCapture: 0,
            }),
        );
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
            }),
    );

    await bridge.rebuildPageContainer(
        new RebuildPageContainer({
            containerTotalNum: textObject.length + tiles.length,
            textObject,
            imageObject: tiles,
        }),
    );
}

export async function buildPage(page: PAGES) {
    appLog("Render page", PAGES[page]);
    switch (page) {
        case PAGES.DASHBOARD:
            const rebuilt = await bridge.rebuildPageContainer(
                new RebuildPageContainer({
                    containerTotalNum: dashboardTiles.length + 1,
                    textObject: [main, ...createDashboardTiles()],
                }),
            );
            if (!rebuilt) appLog("Dashboard rebuild failed");
            break;

        case PAGES.AI:
            await buildDocumentPage(false);
            await enterAiPage();
            break;

        case PAGES.ASSIGNMENT:
            await buildDocumentPage(true);
            await enterAssignmentPage();
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
                    "☹ Currently this page is absent \n\n Double click to go back",
                isEventCapture: 1, // ← receive click events on this container
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
