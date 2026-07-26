// Tile geometry — must stay in sync with the client (test/src/constants.ts).
// The panel is 576×288: a 2×2 grid of 288×128 image tiles (bottom ~30px is a
// text pager), so one document "page" = these four tiles.
export const TILE_W = 288;
export const TILE_H = 126;
export const TILES_X = 2;
export const TILES_Y = 2;
export const PAGE_H = TILE_H * TILES_Y; // 252

// Rows each page repeats from the bottom of the previous one, so a line split
// at the boundary stays readable and there's continuity when paging. Pages
// advance by (PAGE_H - PAGE_OVERLAP). Roughly one line of body text (~30px).
export const PAGE_OVERLAP = 30;

/** A region of the 576×PAGE_H panel, in page coordinates. */
export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

// ── reserved regions ────────────────────────────────────────────────────────
// Areas the glasses keep a permanent text panel over. On the device those are
// text containers, and a text container is TRANSPARENT — so without this the
// panel is unreadable text laid over document text.
//
// The client can't fix it: a page gets four image containers and the document
// is using all four, so there is no layer to slide underneath. Baking the
// background into the tile here costs nothing at runtime and is the only place
// that owns the pixels.
//
// Rects are page-local and identical on every page, since the panel doesn't
// move. MUST MATCH the client's container geometry (test/src/constants.ts) —
// the panel is positioned there and painted here, and nothing checks that they
// agree.
export const HUD_FEEDBACK: Rect = { x: 288, y: 176, w: 288, h: 76 };

/** Border drawn around a reserved region, matching the menu's frame. */
export const HUD_BORDER = 2;
