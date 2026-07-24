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

export const MENU_ITEMS = ["AI", "Adri", "Yula", "Photo"] as const;
export type MenuItem = (typeof MENU_ITEMS)[number];

export enum PAGES {
    DASHBOARD,
    AI,
    ADRI,
    YULA,
    PHOTO,
}

export enum GESTURE_EVENTS {
    TAP,
    DOUBLE_TAP,
    SWIPE_UP,
    SWIPE_DOWN,
}

// ── AI page: live markdown rendering ────────────────────────────────────────
// Markdown server (see /server). In dev, /markdown and /events are proxied to
// it same-origin by Vite (see vite.config.ts) so the webview can open an
// EventSource — hence the empty default. For a packed/hardware build, set
// VITE_MD_SERVER to the server's absolute URL (e.g. http://192.168.0.117:8787).
export const MARKDOWN_SERVER_URL = import.meta.env.VITE_MD_SERVER ?? "";
export const POLL_INTERVAL_MS = 10_000;

// Image containers are capped at 288×144 and 4 per page, so a full 576×288
// frame is a 2×2 grid of 288×128 tiles (the bottom ~30px is left for a text
// pager). One "page" of the document = these four tiles.
export const TILE_W = 288;
export const TILE_H = 128;
export const TILES_X = 2;
export const TILES_Y = 2;
export const PAGE_W = TILE_W * TILES_X; // 576
export const PAGE_H = TILE_H * TILES_Y; // 256

// Container IDs on the AI page.
export const AI_EVENT_LAYER_ID = 1; // full-screen text layer; receives gestures
export const AI_TILE_IDS = [2, 3, 4, 5] as const; // image tiles, row-major
export const AI_PAGER_ID = 6; // bottom text line

export const AI_PAGER_Y = 258;
export const AI_PAGER_H = 30;
