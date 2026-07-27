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

/**
 * The AI page's action menu — reserved only in the `?overlay=menu` render, not
 * in the normal one.
 *
 * Unlike HUD_FEEDBACK this panel is transient, so baking it into every tile
 * would put a dark box through the middle of a document nobody has opened a
 * menu on. Instead the same document is rendered a second time with this rect
 * reserved, and the client swaps to those tiles while the menu is up (see
 * overlayVariant in test/src/docPage.ts). The alternative — the generated
 * all-black backdrop in test/src/render/menuBackdrop.ts — costs 4×230 bytes
 * instead of 4×~2KB, but takes the solution off the screen to show you a menu
 * about it.
 *
 * MUST MATCH MENU_X / MENU_Y / MENU_W / MENU_H in test/src/constants.ts.
 * Nothing checks it: if they drift, the panel's text lands beside its own box.
 */
export const HUD_MENU: Rect = { x: 108, y: 20, w: 360, h: 212 };

/** Border drawn around a reserved region, matching the menu's frame. */
export const HUD_BORDER = 2;
