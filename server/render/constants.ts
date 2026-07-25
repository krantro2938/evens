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
