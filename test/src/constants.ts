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

export const MENU_ITEMS = ["AI", "Adri", "Yula", "Assign"] as const;
export type MenuItem = (typeof MENU_ITEMS)[number];

export enum PAGES {
    DASHBOARD,
    AI,
    ADRI,
    YULA,
    ASSIGNMENT,
}

export enum GESTURE_EVENTS {
    TAP,
    DOUBLE_TAP,
    SWIPE_UP,
    SWIPE_DOWN,
}

// ── document pages: live markdown rendering ─────────────────────────────────
// Document server (see /server). In dev, /markdown, /tiles, /events and
// /assignment/* are proxied to it same-origin by Vite (see vite.config.ts) so
// the webview can open an EventSource — hence the empty default. For a
// packed/hardware build, set VITE_MD_SERVER to the server's absolute URL
// (e.g. http://192.168.0.117:8787).
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
// This assumes a text container draws ABOVE an image container it overlaps. If
// your SDK build z-orders the other way, set FEEDBACK_Y to DOC_PAGER_Y and
// FEEDBACK_H to DOC_PAGER_H and give the pager the left half — the box then
// shares the footer row instead of overlapping, at the cost of fitting only
// `camera_advice` rather than the full sentence.
export const FEEDBACK_W = 288;
export const FEEDBACK_H = 76;
export const FEEDBACK_X = BODY_W - FEEDBACK_W; // 288
export const FEEDBACK_Y = PAGE_H - FEEDBACK_H; // 176
