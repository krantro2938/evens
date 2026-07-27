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
// Five tiles on two rows: the two pages you read from on top, where the tiles
// are half the panel wide, and the rest below. Reading order is also the order
// a swipe walks them.
//
// Camera is last and it is the newest: it owns the live view and every scan
// control, which used to live on the Assignment page. That page is now purely
// for reading what has been transcribed — aiming the camera and reading the
// result are different jobs, and doing both from one screen meant a tap could
// start a job while you were trying to turn a page.
export const MENU_ITEMS = ["AI", "Assign", "Adri", "Yula", "Camera"] as const;
export type MenuItem = (typeof MENU_ITEMS)[number];

/** How many tiles on each row, top to bottom. Must sum to MENU_ITEMS.length. */
export const DASHBOARD_ROWS = [2, 3] as const;
/** Space between tiles, and between the tiles and the panel edge. */
export const DASHBOARD_GAP = 6;

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
    const h = Math.floor((BODY_H - DASHBOARD_GAP * (rows - 1)) / rows);
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
    YULA,
    ASSIGNMENT,
    CAMERA,
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
export const DOC_MENU_ID = 8; // both document pages: the centred action menu
export const DOC_SOLVE_ID = 9; // AI only: the trigger button / solve progress

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
export const Z_MENU = 8; // the action menu is the topmost thing on the page

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
