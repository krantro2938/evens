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
    DASHBOARD_BORDER,
    DASHBOARD_FOOTER_H,
    DASHBOARD_PAD,
    DASHBOARD_PAGER_Y,
    dashboardRects,
    DEFAULT_COLOR,
    DOC_EVENT_LAYER_ID,
    DOC_FEEDBACK_ID,
    DOC_FEEDBACK_LARGE_ID,
    DOC_MENU_ID,
    DOC_PAGER_H,
    DOC_PAGER_ID,
    DOC_PAGER_Y,
    DOC_SOLVE_ID,
    DOC_TILE_IDS,
    FOCUSED_COLOR,
    GESTURE_EVENTS,
    HUD_FEEDBACK_RECT,
    HUD_FEEDBACK_LARGE_RECT,
    IMAGE_PAYLOAD,
    MENU_ITEMS,
    PAGES,
    PANEL_INK_RATIO,
    PANEL_SPACE_W,
    SETTINGS_ID,
    SOLVE_RECT,
    TILE_H,
    TILE_W,
    Z_BACKDROP,
    Z_FEEDBACK,
    Z_FEEDBACK_LARGE,
    Z_PAGER,
    Z_SOLVE,
    Z_TILE_BASE,
    Z_ORDER_ENABLED,
    zOrder,
} from "./constants";
import { GlobalState } from "./state";
import {
    armDashboardSleep,
    dashboardAsleep,
    handleDashboardEvent,
    leaveDashboardPage,
} from "./dashboard";
import {
    buildMessagesPage,
    handleMessagesPageEvent,
    leaveMessagesPage,
    startMessageStream,
    textWidth,
} from "./messages";
import { clockStr, stringToShortId } from "./utils";
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
import { loadBridge } from "./gallery";
import { getMode, initBackend, remoteReachable } from "./services/backend";

initBackend();

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

/**
 * The dashboard's footer, awake — a status line, not a gesture target.
 *
 * The tile grid only fills DASHBOARD_ROWS worth of the panel now (see
 * DASHBOARD_FOOTER_H), which leaves a blank strip under it. That matters
 * because the SDK caps a page at 8 text containers and main + 7 tiles is
 * already there (see DASHBOARD_ROWS in constants.ts) — a dedicated ninth
 * container for the footer would not fit, so this reuses container 1, which
 * used to be nothing but a full-screen blank event catcher.
 *
 * It does NOT carry isEventCapture anymore (see createDashboardTiles): a
 * container the host is told to capture gestures on is also one it will
 * attach its own native scroll/bounce to once it holds real text, the same
 * way a page's SCROLLER attaches once a TextContainer overflows (see the
 * line-budget note in settings.ts). The blank full-screen version of this
 * container never showed that because it never had real content; the first
 * real text put in here (the online/mode/clock line) did. Every OTHER page
 * keeps those two jobs on separate containers — the doc page's blank
 * `eventLayer` versus its text-bearing `pager` — this is the one page where
 * they can't be, so the capture moved to the first tile instead, which only
 * ever holds a short label and never overflows.
 *
 * Full-screen and blank while asleep: sleeping draws NOTHING (see
 * dashboard.ts), and a footer that kept ticking would defeat that.
 */
function createDashboardBackdrop(sleeping: boolean): TextContainerProperty {
    return new TextContainerProperty({
        xPosition: 0,
        yPosition: sleeping ? 0 : DASHBOARD_PAGER_Y,
        width: BODY_W,
        height: sleeping ? BODY_H : DASHBOARD_FOOTER_H,
        borderWidth: 0,
        borderColor: 5,
        containerID: 1,
        containerName: "main",
        content: sleeping ? " " : dashboardFooterLabel(),
        isEventCapture: sleeping ? 1 : 0,
        ...zOrder(Z_BACKDROP),
    });
}

/**
 * A tile label, nudged to the middle of its tile with spaces.
 *
 * A text container has no alignment — the SDK's TextContainerProperty is
 * position, size, border, padding and content, and the content lands top-left
 * inside the padding. The other pages get around that by shrinking a box to hug
 * its text and centring the box (see bannerContainers in messages.ts); the
 * dashboard cannot, because these borders ARE the grid.
 *
 * So it counts spaces. TWO different widths do that job, and they are not
 * interchangeable:
 *
 *   where to put it   PANEL_INK_RATIO × textWidth, and PANEL_SPACE_W — the
 *                     font as measured off the panel. The first version of this
 *                     used textWidth() alone and every label sat ~15px left,
 *                     because a space draws 5px wide and the estimator says 7.
 *   what still fits   textWidth() raw, which overestimates. The cap has to be
 *                     conservative in the direction that costs pixels.
 *
 * THE CAP IS NOT DEFENSIVE, it is load-bearing. A label padded past the inner
 * width wraps, and a tile holding more than it can show gets a SCROLLER
 * attached by the host (see constants.ts) — which would then eat the swipes
 * that move the focus, on the page whose only gestures are swipes. So the
 * measured half-slack is capped by the estimated whole slack, and a label
 * already wider than its tile (the Msgs count is the one that grows) is
 * returned untouched: no centring, rather than a broken dashboard.
 *
 * Only horizontal. Vertical moves in whole lines — a label sits 6px under the
 * inner top today, and one newline is worth ~27px against the ~50px it needs —
 * so it lands visibly high or visibly low but never in the middle.
 */
function centreLabel(label: string, tileWidth: number): string {
    const inner = tileWidth - 2 * (DASHBOARD_BORDER + DASHBOARD_PAD);
    const estimated = textWidth(label);
    if (inner <= estimated) return label;

    const drawn = estimated * PANEL_INK_RATIO;
    const spaces = Math.min(
        Math.round((inner - drawn) / (2 * PANEL_SPACE_W)),
        Math.floor((inner - estimated) / PANEL_SPACE_W),
    );
    return " ".repeat(spaces) + label;
}

/** How much text the footer strip holds — see FOOTER_COLS in assignment.ts. */
const DASHBOARD_FOOTER_COLS = 40;

/** Hard-clip one line to what the footer strip can draw. */
function clipFooter(text: string): string {
    return text.length <= DASHBOARD_FOOTER_COLS
        ? text
        : `${text.slice(0, DASHBOARD_FOOTER_COLS - 1)}…`;
}

/**
 * Online status, mode and the wall clock — the dashboard's one status line.
 *
 * Status (reachability, derived) sits on the left; the raw mode — what
 * Setup actually has selected, auto/online/offline — sits on the right so
 * the two don't get confused: "Auto/offline" on the left is a status, not a
 * mode, and this line makes clear which one you're looking at.
 */
function dashboardFooterLabel(): string {
    const mode = getMode();
    const online = remoteReachable();
    const status =
        mode === "offline"
            ? "Offline"
            : mode === "auto" && !online
              ? "Auto/offline"
              : !online
                ? "No server"
                : "Online";
    const left = `${status}  ${clockStr()}`;
    const right = `[${mode}]`;
    const gap = Math.max(2, DASHBOARD_FOOTER_COLS - left.length - right.length);
    return clipFooter(`${left}${" ".repeat(gap)}${right}`);
}

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
            borderWidth: DASHBOARD_BORDER,
            borderColor: isItemFocused ? FOCUSED_COLOR : DEFAULT_COLOR,
            borderRadius: BODY_RADIUS,
            paddingLength: DASHBOARD_PAD,
            containerID: stringToShortId(item),
            containerName: item,
            // The Msgs tile carries the unread count. This is the app's only
            // notification indicator: a document page has no spare layer to put
            // one on (see messages.ts), and a tile you already walk past on the
            // way to everything else is a better home for it than a permanent
            // hole in every rendered document.
            //
            // Centred after the count is folded in, not before: "Msgs" and
            // "Msgs 12" are different widths, and a tile whose label jumps left
            // when a message lands would be a worse indicator than no centring.
            content: centreLabel(
                item === "Msgs" && GlobalState.unreadMessages > 0
                    ? `${item} ${GlobalState.unreadMessages}`
                    : item,
                rect.w,
            ),
            // The first tile carries the page's one isEventCapture instead of
            // the footer container — see createDashboardBackdrop. Its label
            // is a few characters, never enough to overflow and invite the
            // host's own scroller the way the footer's status line did.
            isEventCapture: index === 0 ? 1 : 0,
            ...zOrder(Z_TILE_BASE + index),
        });
    });
}

const dashboardTiles = createDashboardTiles();

// Render the page. `result` is 0 on success.
const startUpPage = new CreateStartUpPageContainer({
    containerTotalNum: dashboardTiles.length + 1,
    textObject: [createDashboardBackdrop(false), ...dashboardTiles],
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

    // A RELOAD lands here if the host refuses a second start-up page — the app
    // is already launched as far as it is concerned, and Setup > Restart app
    // reloads this WebView inside that same launch (see settings.ts).
    // rebuildPageContainer is the call for a page that already exists, so try
    // it rather than boot to a panel nobody can get off.
    const recovered = await bridge.rebuildPageContainer(
        new RebuildPageContainer({
            containerTotalNum: dashboardTiles.length + 1,
            textObject: [createDashboardBackdrop(false), ...dashboardTiles],
        }),
    );
    appLog("Dashboard rebuild after failed create:", recovered ? "ok" : "FAILED");
}

// Opened here rather than by the Messages page, and never closed. A message has
// to reach you on whichever page you are standing on, so this is the one stream
// in the app that outlives navigation — everything else in docPage.ts is
// deliberately torn down when you walk away from it.
startMessageStream();

// The gallery bridge, from the server rather than from this device's storage —
// the WebView does not keep localStorage across launches, so on the glasses it
// was never configured twice running. Nothing waits for it: the Settings page
// is several gestures away, and its "publish the newest photo" button reads the
// value when you press it.
void loadBridge();

// The start-up page above is the one dashboard this app draws without going
// through buildPage(), so its countdown has to be started by hand — otherwise
// the app boots to a dashboard that never sleeps until you touch it.
armDashboardSleep();

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

            // A dark dashboard is asleep, not on its way out: the gesture that
            // quits the app is the one that turns the screen back on, so waking
            // wins while it sleeps. Quitting from dark is two double taps —
            // which is the right price for the irreversible one of the pair.
            if (dashboardAsleep()) {
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
        // Not a stream or a timer that costs anything — but a sleep timer that
        // survives the walk to another page blanks that page's dashboard the
        // moment you come back to it.
        case PAGES.DASHBOARD:
            leaveDashboardPage();
            break;
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
            panelContainer({
                containerID: DOC_FEEDBACK_LARGE_ID,
                name: "feedbackLarge",
                rect: HUD_FEEDBACK_LARGE_RECT,
                zOrderIndex: Z_FEEDBACK_LARGE,
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
            // Asleep, this is the backdrop and nothing else: no tiles drawn, so
            // nothing lit, and `main` still captures the double tap that brings
            // them back. Checked here rather than in a render path of its own so
            // that every caller — a swipe, an arriving message's unread count —
            // repaints a dark dashboard dark instead of waking it. See
            // src/dashboard.ts.
            //
            // createDashboardTiles() rebuilds from focus state, so this carries
            // the same z-order the start-up page did — see Z_BACKDROP.
            const sleeping = dashboardAsleep();
            const dashboard = new RebuildPageContainer({
                containerTotalNum: sleeping ? 1 : dashboardTiles.length + 1,
                textObject: sleeping
                    ? [createDashboardBackdrop(true)]
                    : [createDashboardBackdrop(false), ...createDashboardTiles()],
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
            // Every repaint of a LIT dashboard restarts the countdown: a swipe
            // that moves the focus, a message that changes the unread count, the
            // double tap that woke it. Arming it while asleep would blank an
            // already blank screen every seven seconds, forever.
            if (!sleeping) armDashboardSleep();
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

        // One full-screen text container and nothing else: this page is a short
        // list and a sentence about whichever row is focused, so there is
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
