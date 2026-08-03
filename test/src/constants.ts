export const BODY_W = 576;
export const BODY_H = 288;
export const BODY_PAD = 10;
export const CONTAINER_PAD = 10;
export const BODY_RADIUS = 6;
export const BODY_BORDER = 0;

export const LINE_HEIGHT = 27;

export const FOCUSED_COLOR = 7;
export const DEFAULT_COLOR = 1;

// const INNER_W = BODY_W - 2 * (BODY_PAD + BODY_BORDER)
// const INNER_H = BODY_H - 2 * (BODY_PAD + BODY_BORDER)

// ── the dashboard ───────────────────────────────────────────────────────────
// Six tiles on two rows of three: the two pages you read from lead, and reading
// order is also the order a swipe walks them.
//
// Camera owns the live view and every scan control, which used to live on the
// Assignment page. That page is now purely for reading what has been
// transcribed — aiming the camera and reading the result are different jobs,
// and doing both from one screen meant a tap could start a job while you were
// trying to turn a page.
//
// Setup is last, and it is deliberately the furthest tile from where a swipe
// starts: its one action replaces the whole assignment with a photo from the
// phone (see settings.ts), and the entry to that should not be somewhere you
// arrive by overshooting.
// Msgs sits in the top row and NOT at the end: Setup keeps the last slot for
// the reason below, and messages are something you check on the way past rather
// than navigate to deliberately. The unread count is drawn into this tile (see
// createDashboardTiles) — that count is the whole notification indicator, which
// is why no document page reserves pixels for one.
export const MENU_ITEMS = ["AI", "Assign", "Msgs", "Adri", "Mine", "Camera", "Setup"] as const;
export type MenuItem = (typeof MENU_ITEMS)[number];

/**
 * How many tiles on each row, top to bottom. Must sum to MENU_ITEMS.length.
 *
 * Seven items is 8 text containers with the backdrop, which is exactly the
 * SDK's textObject ceiling. An eighth tile does not fit — `rebuildPageContainer`
 * rejects the page and leaves the PREVIOUS one on screen, so the dashboard
 * would simply stop changing rather than report anything.
 */
export const DASHBOARD_ROWS = [4, 3] as const;
/** Space between tiles, and between the tiles and the panel edge. */
export const DASHBOARD_GAP = 6;
/**
 * Strip left under the grid for the dashboard's footer (online status, mode,
 * clock — see dashboardFooterLabel in src/main.ts), sized the same as a
 * document page's DOC_PAGER_H. Without it the grid filled the full BODY_H and
 * the footer had nowhere to draw at all.
 *
 * It isn't a dedicated container: the SDK caps a page at 8 text containers
 * and main + 7 tiles already uses all 8, so the footer text is drawn by the
 * backdrop container (id 1) shrunk down to this strip while the dashboard is
 * awake. See createDashboardBackdrop in src/main.ts.
 */
export const DASHBOARD_FOOTER_H = 36;
/** Where that strip starts. */
export const DASHBOARD_PAGER_Y = BODY_H - DASHBOARD_FOOTER_H;
/**
 * The tile frame. Named because the label's centring subtracts it: the width a
 * label has to sit in is the tile minus this and the padding on both sides, and
 * a border that changed here while the arithmetic kept the old number would put
 * every label slightly off centre. See createDashboardTiles in src/main.ts.
 */
export const DASHBOARD_BORDER = 2;
/**
 * A pixel tighter than CONTAINER_PAD everywhere else, and that pixel is the
 * point: the text origin is border + padding, so this is the only sub-space
 * knob the centring has. Spaces move a label in 5px steps (see PANEL_SPACE_W),
 * which leaves labels sitting up to 3px right of centre with no smaller step
 * available; one less pixel of padding takes the whole set 1px back left.
 *
 * It shifts the label DOWN-to-UP too — padding is uniform on four sides — which
 * a tile 141px tall holding one line can afford.
 *
 * centreLabel() in src/main.ts must measure against this same number. Centring
 * against a 10px window while the host lays out with 9 would put the label back
 * where it started, since the extra pixel would land as one more space.
 */
export const DASHBOARD_PAD = CONTAINER_PAD - 1;

/**
 * The panel font, measured rather than estimated.
 *
 * textWidth() in messages.ts is a deliberate OVERestimate — it sizes message
 * bubbles, where guessing small costs a line the box has no room for and the
 * host attaches a scroller. Centring wants the opposite: the real number, since
 * the error lands on screen as an off-centre label rather than as slack.
 *
 * Both figures come off a simulator screenshot, which maps the panel 1:1 (576
 * ×288), by finding the lit pixels inside each dashboard tile: seven spaces
 * before "AI" measured 35px, three before "Assign" 15px, five before "Adri"
 * 25px — a space is 5px, not the 7 the estimator assumes. Against the same
 * labels the estimator overshoots the drawn ink by 0.71–0.83; 0.78 is the
 * middle of that, and half a space (2.5px) is the accuracy on offer anyway.
 *
 * Only the dashboard uses these, and only for centring. Anything SIZING a box
 * should keep using textWidth() and its slack.
 */
export const PANEL_SPACE_W = 5;
export const PANEL_INK_RATIO = 0.78;

/**
 * How long the dashboard sits there before it blanks itself.
 *
 * The dashboard is the page you are on whenever you are not doing anything, so
 * it is the page that spends the most time lit in front of your eye for no
 * reason. After this it draws nothing and waits for a double tap. See
 * src/dashboard.ts — nothing is torn down, only the tiles stop being drawn.
 */
export const DASHBOARD_SLEEP_MS = 7_000;

export interface TileRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/**
 * Where each dashboard tile sits, in MENU_ITEMS order.
 *
 * Computed rather than written out so the row spec above is the only thing to
 * change when a page is added — the previous version hard-coded a 2×2 grid in
 * index arithmetic, which is exactly the kind of thing that silently draws the
 * fifth tile on top of the first.
 */
export function dashboardRects(): TileRect[] {
    const rows = DASHBOARD_ROWS.length;
    const h = Math.floor(
        (BODY_H - DASHBOARD_FOOTER_H - DASHBOARD_GAP * (rows - 1)) / rows,
    );
    const rects: TileRect[] = [];

    DASHBOARD_ROWS.forEach((count, row) => {
        const w = Math.floor((BODY_W - DASHBOARD_GAP * (count - 1)) / count);
        for (let col = 0; col < count; col++) {
            rects.push({
                x: col * (w + DASHBOARD_GAP),
                y: row * (h + DASHBOARD_GAP),
                w,
                h,
            });
        }
    });

    return rects;
}

export enum PAGES {
    DASHBOARD,
    AI,
    ADRI,
    MINE,
    ASSIGNMENT,
    CAMERA,
    SETTINGS,
    MESSAGES,
    /** The Mine tile's chooser: your own answer, or the encyclopedia. */
    MINE_HUB,
    /** Walking the encyclopedia's tree. Text only — see src/enc/browser.ts. */
    ENC_BROWSE,
    /** Reading one encyclopedia node. See src/enc/reader.ts. */
    ENC_READ,
}

export enum GESTURE_EVENTS {
    TAP,
    DOUBLE_TAP,
    SWIPE_UP,
    SWIPE_DOWN,
}

// ── document pages: live markdown rendering ─────────────────────────────────
// The document server (see /server) is the app's only backend: /markdown,
// /tiles, /events and /assignment/* all come from it.
//
// Empty is the right default. In dev those routes are proxied same-origin by
// Vite (VITE_MD_TARGET, see vite.config.ts) because the webview refuses a
// cross-origin EventSource. Only a packed/hardware build needs an absolute URL
// here — set VITE_MD_SERVER then. See .env.example.
export const MARKDOWN_SERVER_URL = import.meta.env.VITE_MD_SERVER ?? "";
export const POLL_INTERVAL_MS = 10_000;

/** Path prefixes on the document server, one per document page. */
export const DOC_BASE_SOLUTION = "";
export const DOC_BASE_ASSIGNMENT = "/assignment";
/** The hand-written document, edited in the companion app. See src/adri.ts. */
export const DOC_BASE_ADRI = "/adri";
/** Your own answer to the scanned assignment, also hand-written. See src/mine.ts. */
export const DOC_BASE_MINE = "/mine";
/**
 * The offline study pack. NOT a document base — there is no /enc/markdown and
 * no /enc/events, because nothing about it is live: it is 151 nodes of pages
 * that were rendered once by tools/enc and committed. See src/enc/pack.ts.
 */
export const DOC_BASE_ENC = "/enc";

// Image containers are capped at 288×144 and 4 per page, so a full 576×288
// frame is a 2×2 grid of 288×128 tiles (the bottom ~30px is left for a text
// pager). One "page" of the document = these four tiles.
export const TILE_W = 288;
export const TILE_H = 126;
export const TILES_X = 2;
export const TILES_Y = 2;
export const PAGE_W = TILE_W * TILES_X; // 576
export const PAGE_H = TILE_H * TILES_Y; // 248

// Container IDs on a document page. Only one document page is live at a time,
// so the AI and Assignment pages share the same ids.
export const DOC_EVENT_LAYER_ID = 1; // full-screen text layer; receives gestures
export const DOC_TILE_IDS = [2, 3, 4, 5] as const; // image tiles, row-major
export const DOC_PAGER_ID = 6; // bottom text line
export const DOC_FEEDBACK_ID = 7; // assignment only: camera advice / start-stop
export const DOC_FEEDBACK_LARGE_ID = 10; // camera advice over the small preview
export const DOC_MENU_ID = 8; // both document pages: the centred action menu
export const DOC_SOLVE_ID = 9; // AI only: the trigger button / solve progress

/**
 * The Settings page is one full-screen text container and nothing else.
 *
 * It has no tiles to stack against and one thing to say at a time, so a second
 * container would only be somewhere for the two halves of a sentence to
 * disagree. Shares id 1 with the dashboard's backdrop: container ids need to be
 * unique on a PAGE, and only one page is ever built.
 */
export const SETTINGS_ID = 1;

// ── the encyclopedia's two pages (src/enc/) ─────────────────────────────────
//
// The browser is one text container and nothing else, like Settings, and for
// the same reason: it says one thing at a time and has no tiles to stack
// against. It shares id 1 with every other single-container page — ids need to
// be unique on a PAGE, and only one page is ever built.
export const ENC_BROWSE_ID = 1;

/**
 * The reader's containers.
 *
 * ONE layout for both kinds of page. A node interleaves prose that ships as
 * text with formulas that ship as images (see tools/enc/paginate.ts), and
 * rebuilding the page container on every switch would flash the panel and cost
 * a round of BLE on a gesture that is supposed to be a page turn. So the page
 * carries both: a text page blanks the tiles and writes the body, an image
 * page blanks the body and pushes the tiles.
 *
 * ENC_BODY_ID is deliberately NOT the event layer. `isEventCapture: 1` on a
 * container holding real text is one of the two known causes of the host
 * attaching its own scroller, and that scroller then swallows the swipes that
 * turn the page.
 */
export const ENC_EVENT_LAYER_ID = 1;
/**
 * The same four ids a document page uses — an ALIAS, not a copy.
 *
 * render/tilePush.ts resolves an index to a container through DOC_TILE_IDS
 * directly, so a second list that merely happened to hold the same numbers
 * would work right up until one of them was changed, and then push tiles to
 * the wrong containers with nothing to explain why.
 */
export const ENC_TILE_IDS = DOC_TILE_IDS;
export const ENC_PAGER_ID = 6;
export const ENC_BODY_ID = 7;

// ── the Messages page: one container per bubble ─────────────────────────────
//
// A text container draws a BOX — borderWidth and borderRadius, the same ones
// the dashboard tiles use — and it sits wherever you put it. That is a chat
// bubble: give each message its own container, size it to its text, and place
// it against the left edge or the right one.
//
// Which makes the layout the page's own job rather than a renderer's. Geometry
// is fixed when a container is built, so a conversation that has changed — a
// message arrived, or you scrolled — is a new set of containers and a page
// rebuild. That is cheap here: this page has no image containers, so a rebuild
// costs one call and no BLE payload at all.
//
// EVERY BUBBLE MUST BE TALL ENOUGH FOR ITS TEXT. Overflow is not clipped, it is
// scrolled — the host attaches a scroller to any text container holding more
// than it can show, and that scroller then eats the swipes meant for the page.
// So the height comes from the wrap, the wrap comes from the width, and the
// width comes from textWidth() in messages.ts, which is an ESTIMATE of a
// proportional font. Everything below is sized with slack for that estimate to
// be wrong in the direction that costs pixels rather than the one that costs a
// scroller.

/** One per message on screen, plus the layer that catches gestures. */
export const MSG_EVENT_ID = 1;
export const MSG_BUBBLE_IDS = [2, 3, 4, 5, 6] as const;
export const MSG_HINT_ID = 7;
/** The reply picker. Its own page, not an overlay — see messages.ts. */
export const MSG_REPLY_ID = 8;
/**
 * The arrival cards: what has just landed, stacked, newest at the bottom.
 *
 * Share ids 2..4 with the first bubbles because ids only have to be unique
 * within ONE payload, and no page ever carries both — an arrival is the cards,
 * opening the conversation is the bubbles.
 */
export const MSG_BANNER_IDS = [2, 3, 4] as const;
/** The line above the stack, when there are arrivals the stack has no room for. */
export const MSG_BANNER_MORE_ID = 5;

/**
 * How many bubbles can be on screen at once.
 *
 * Not a design choice: the SDK takes at most 8 text containers per page, and
 * this page spends one on the gesture layer, one on the hint strip and one on
 * the reply picker. A ninth container is not clipped — `rebuildPageContainer`
 * REJECTS the page and leaves the previous one up, so the symptom would be a
 * Messages page that simply stops changing.
 */
export const MSG_MAX_BUBBLES = MSG_BUBBLE_IDS.length;

/**
 * The strip along the bottom that says what a gesture will do.
 *
 * The same 36px the document pager gets, written out rather than shared with
 * DOC_PAGER_H: that constant is declared further down this file, and a `const`
 * that reads another one above its declaration throws at module load rather
 * than reading as undefined.
 */
export const MSG_HINT_H = 36;
export const MSG_HINT_Y = BODY_H - MSG_HINT_H; // 252

/** Bubbles live above the hint strip and hang from the bottom of that space. */
export const MSG_FLOOR = MSG_HINT_Y;

// A bubble stops well short of the far edge, so which side it is on stays
// obvious even when it is a long message — the side IS the sender here, since
// a text container has no fill to distinguish them with.
export const BUBBLE_MAX_W = 430;
export const BUBBLE_MIN_W = 70;
export const BUBBLE_PAD = 6;
export const BUBBLE_BORDER = 2;
export const BUBBLE_RADIUS = 8;
/** Gap between stacked bubbles. */
export const BUBBLE_GAP = 5;
/**
 * Row height inside a bubble. Deliberately roomier than LINE_HEIGHT, for the
 * same reason MENU_LINE_H is: that constant is this app's assumption about the
 * panel font, and a bubble that is two pixels short of its own text gets a
 * scroller instead of a scrollbar-free box.
 */
export const BUBBLE_LINE_H = 30;
/** Margin from the panel edge to the bubble on its side. */
export const BUBBLE_EDGE = 6;

// ── the arrival cards ───────────────────────────────────────────────────────
// What has just arrived: one centred box per message, stacked, newest at the
// bottom — and nothing else.
//
// Not the conversation. A message arriving takes the panel away from whatever
// you were doing, so what it puts there has to be readable at a glance and then
// gone — the history behind it is something you go and look at (swipe up), not
// something you are shown while you are trying to read one sentence.
//
// Roomier than a bubble on every axis, because these are the only things on
// screen: wider before they wrap, more padding, and a taller line.
export const BANNER_MAX_W = 500;
export const BANNER_MIN_W = 200;
export const BANNER_PAD = 12;
export const BANNER_BORDER = 2;
export const BANNER_RADIUS = 10;
export const BANNER_LINE_H = 32;
/** Between stacked cards, and between the stack and the line above it. */
export const BANNER_GAP = 8;

/**
 * How many arrivals are shown at once. Beyond this the oldest of them become a
 * count on one line, because four boxes on a panel is a page to read rather
 * than a thing to glance at — and the conversation is one swipe away.
 *
 * Three also leaves the page inside the SDK's 8-text-container ceiling: gesture
 * layer, three cards, the count line and the hint strip is six.
 */
export const BANNER_MAX_CARDS = MSG_BANNER_IDS.length;
/** The count line. One line, no border — it is a label, not another card. */
export const BANNER_MORE_H = BANNER_LINE_H;

// ── z-order on the Messages page ────────────────────────────────────────────
// Bubbles never overlap each other, so their order among themselves does not
// matter — but the all-or-nothing rule means every container on the page needs
// one anyway (see Z_ORDER_ENABLED).
export const Z_BUBBLE_BASE = 2; // bubbles take 2..6
export const Z_BANNER_BASE = 2; // arrival cards take 2..4, never with bubbles
export const Z_BANNER_MORE = 5; // the count line above them
export const Z_HINT = 7;
export const Z_REPLY = 8;

/**
 * How long an arriving message holds the screen before it hands it back.
 *
 * Scaled, not fixed: 240 characters is about 45 words, which nobody reads on a
 * HUD in the 7 seconds that is plenty for "on my way". Floor 7s, a second per
 * 20 characters, capped so a long message can't sit on your face indefinitely.
 */
export const BANNER_MIN_MS = 7_000;
export const BANNER_MAX_MS = 15_000;
export const BANNER_MS_PER_20_CHARS = 1_000;

export function bannerMs(text: string): number {
    const scaled = BANNER_MIN_MS + Math.floor(text.length / 20) * BANNER_MS_PER_20_CHARS;
    return Math.min(BANNER_MAX_MS, scaled);
}

// ── image payload shape ─────────────────────────────────────────────────────
// SDK 0.0.12 stamps `compressMode: 2` — LZ4 — into every `updateImageRawData`
// payload, in ImageRawDataUpdate.toJson(), with no way to turn it off. 0.0.10
// sent no such field.
//
// That is what stopped the tiles arriving: on the day this project moved from
// ^0.0.10 to ^0.0.12 (for zOrderIndex), every image push began returning
// `sendFailed` while text upgrades — which carry no compressMode — kept working
// perfectly. An Even Hub host that predates LZ4 support cannot take the
// compressed payload, so it refuses the send. Nothing reaches the glasses, and
// nothing about the image itself is wrong.
//
//   "legacy"  send the pre-0.0.12 shape: no compressMode. Works with the host
//             that is actually on the phone.
//   "sdk"     let 0.0.12 do what it wants. Switch to this once the Even Hub app
//             on the phone is new enough — it is the supported path, and LZ4 on
//             a ~10-30 KB/s link is worth having.
//
// The startup log line says which mode a build is running, because this is
// exactly the sort of thing you cannot tell by looking at the glasses.
export const IMAGE_PAYLOAD: "legacy" | "sdk" = "legacy";

// ── stacking order (SDK >= 0.0.12) ──────────────────────────────────────────
// Larger values draw in front. Without this the host stacks by declaration
// order, and `rebuildPageContainer` sends textObject and imageObject as
// separate lists — so the image tiles landed on top of every text container and
// anything overlapping them (the camera-advice box, the action menu) was drawn
// but never seen.
//
// Two rules the host does not forgive, both checked by
// validateEvenHubPageContainerZOrder before the payload leaves:
//   - all or nothing: if one container on the page sets it, every text, list
//     and image container must set it too;
//   - no duplicates on a page — there is no tie-break.
//
// Ordering has nothing to do with input: exactly one container per page carries
// isEventCapture, and that still routes the gestures wherever it sits.
//
// EVERY page sets these, including the dashboard, whose containers never
// overlap and so don't care about the order. "All or nothing" is the rule, and
// a page that omits it after another page has used it is the kind of
// inconsistency that leaves you staring at a blank panel with nothing logged.
//
// Numbering starts at 1, not 0: a zero here is indistinguishable from "unset"
// to anything that treats it as a protobuf default, and this codebase has
// already been bitten by exactly that (see the CLICK_EVENT case in main.ts).
export const Z_BACKDROP = 1; // full-screen gesture catcher, behind everything
export const Z_TILE_BASE = 2; // the four tiles take 2..5
export const Z_PAGER = 6;
// 7 is one page's panel or the other's: the assignment page has the camera
// advice box, the AI page has the solve button, and no page has both. Slots are
// per page — they must be unique on a page, not across the app.
export const Z_FEEDBACK = 7; // over the tile it overlaps
export const Z_SOLVE = 7; // AI page: the trigger button, over the backdrop
export const Z_FEEDBACK_LARGE = 8; // enlarged camera advice over the small preview
export const Z_MENU = 9; // the action menu is the topmost thing on the page

/**
 * Master switch. Set false to go back to declaration-order stacking everywhere
 * — the pre-0.0.12 behaviour, where the image tiles cover any text they
 * overlap. Worth reaching for if a host that predates z_order_index does
 * something worse with the field than ignore it.
 *
 * Spread it in — `...zOrder(Z_MENU)` — rather than assigning `zOrderIndex`
 * directly: passing `undefined` still puts the key on the wire, which is NOT
 * the same as leaving it out, and "absent" is the only thing the all-or-nothing
 * rule accepts.
 */
// TESTED AND EXONERATED (2026-07-26). When every image push started returning
// `sendFailed` while text upgrades kept working, this field was the obvious
// suspect — it had just been added to every container, and the SDK notes that
// omitting it stays valid for older app pages, so a host that predated it could
// have been holding a different page than the one it reported building.
//
// It wasn't that. A build with this false logged `Dashboard created 0 | z-order
// OFF` and the tiles failed identically. The image path from the phone to the
// glasses was down; nothing in this app's payload was wrong.
export const Z_ORDER_ENABLED = true;
export const zOrder = (value: number): { zOrderIndex?: number } =>
    Z_ORDER_ENABLED ? { zOrderIndex: value } : {};

// Footer sits directly below the 256px tile area (2×128) and fills the rest of
// the 288px panel — the full 32px helps the single-line label fit without the
// host adding a scroller.
export const DOC_PAGER_Y = PAGE_H; // 252
export const DOC_PAGER_H = BODY_H - PAGE_H; // 36

// ── assignment page: the feedback / control box ─────────────────────────────
// Sits in the bottom-right corner, overlapping the lower part of the
// bottom-right image tile (which spans x 288-576, y 126-252). It shows the
// model's camera advice while a job runs, and the tap-to-start hint when
// nothing is happening — so it's always present and the page never needs a
// rebuild (border width is part of the page definition, not upgradable).
//
// It overlaps a tile, so it depends on Z_FEEDBACK putting it in front. Before
// zOrderIndex existed the host stacked by declaration order and the image tiles
// covered this box completely — it was drawn on every capture and never once
// seen. If it goes blank again, suspect the stack (see Z_* above) first.
//
// ITS BACKGROUND AND FRAME ARE NOT DRAWN HERE. A text container is transparent,
// so this rectangle is `reserved` when the server renders the assignment's
// tiles — they arrive with it already dark and framed (see HUD_FEEDBACK in
// server/render/constants.ts). THESE FOUR NUMBERS MUST MATCH THAT RECT. Nothing
// checks it: if they drift, the text lands beside its own background.
export const FEEDBACK_W = 288;
export const FEEDBACK_H = 76;
export const FEEDBACK_X = BODY_W - FEEDBACK_W; // 288
export const FEEDBACK_Y = PAGE_H - FEEDBACK_H; // 176

/** The same rectangle the server reserves. Add one of these per panel. */
export const HUD_FEEDBACK_RECT = {
    x: FEEDBACK_X,
    y: FEEDBACK_Y,
    w: FEEDBACK_W,
    h: FEEDBACK_H,
} as const;

/** When the preview is one tile in the top-left, the rest of the page can
 * carry a readable multi-line guidance panel. */
export const HUD_FEEDBACK_LARGE_RECT = {
    x: 0,
    y: TILE_H,
    w: BODY_W,
    h: PAGE_H - TILE_H,
} as const;

// ── the action menu (src/menu.ts) ───────────────────────────────────────────
// A centred panel listing every action at once, with a "> " marker that slides
// as you swipe. Sized for a heading plus five entries — five being the longest
// menu any page currently builds.
//
// It is declared with the page and simply holds " " while closed: border width
// is fixed at build time, so a bordered container that only existed while the
// menu was open would force a full page rebuild — and a re-push of all four
// tiles — every time you opened it. A blank text container draws nothing, so
// this costs one container and no rebuild.
//
// The panel sits over the tiles and relies on Z_MENU to be seen. That needs the
// HOST to understand z_order_index, not just this SDK — on an older Even Hub
// build the field is ignored and declaration order applies again, which puts
// the tiles back on top. The footer keeps mirroring the selection for exactly
// that case; if the panel is invisible, set MENU_IN_FOOTER and the menu lives
// in the footer strip alone, where no tile can reach it.
export const MENU_IN_FOOTER = false;
export const MENU_MAX_ENTRIES = 5;
export const MENU_LINES = MENU_MAX_ENTRIES + 1; // + the heading
export const MENU_W = 360;
// Deliberately roomier than LINE_HEIGHT. That constant is this app's assumption
// about the panel font, not a measurement, and the host adds a scroller (or
// clips) the moment content doesn't fit — see the note at DOC_PAGER_H. A menu
// that overflows by two pixels is a menu you can't read, and the slack costs
// nothing but 30px of a panel that is only up while you're choosing.
export const MENU_LINE_H = 32;
export const MENU_H = MENU_LINES * MENU_LINE_H + 2 * CONTAINER_PAD; // 212
export const MENU_X = Math.round((BODY_W - MENU_W) / 2); // 108
export const MENU_Y = Math.round((PAGE_H - MENU_H) / 2); // 35

// ── AI page: the solve button (src/ai.ts) ───────────────────────────────────
// The trigger for a Claude solve, and the progress report while one runs. It is
// modal in the same sense the menu is — when there is no solution for the paper
// in front of you, reading the document is not what you're here for — so it
// borrows the menu's machinery outright: same rectangle, same generated dark
// backdrop over the tiles, same frame baked into it.
//
// Sharing the rect is not laziness, it is the reason no new asset is needed:
// the frame lives in render/menuBackdrop.ts and is drawn for MENU_* geometry. A
// button of its own size would need its own generated backdrop, and would then
// have to be regenerated in step with it.
export const SOLVE_RECT = {
    x: MENU_X,
    y: MENU_Y,
    w: MENU_W,
    h: MENU_H,
} as const;
