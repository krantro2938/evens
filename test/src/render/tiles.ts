// Client side of tile rendering: the server (see /server) does the heavy
// markdown → PNG rasterization; here we just fetch the finished tiles, decode
// them, and hand geometry to the page builder. No marked/MathJax/html2canvas
// on-device anymore.

import { MARKDOWN_SERVER_URL, TILE_H, TILES_X, TILES_Y, TILE_W } from "../constants";

export interface Tile {
    /** Index 0..3, row-major: matches DOC_TILE_IDS ordering. */
    index: number;
    bytes: Uint8Array;
}

export interface TilePage {
    tiles: Tile[];
}

interface TilesResponse {
    version: number;
    pages: { tiles: { index: number; data: string }[] }[];
    /** Which overlay rect the server actually reserved, if any. */
    overlay?: string | null;
}

export interface TilesResult {
    version: number;
    pages: TilePage[];
    /**
     * What the server says it reserved. Absent from a server that predates
     * `?overlay=` and therefore ignored it — which is the case worth catching,
     * because those tiles are the plain document and masking a menu with them
     * leaves the menu unreadable over the text it failed to cover.
     */
    overlay: string | null;
}

/** Also used for the menu's backdrop tiles, which ship base64 in the bundle. */
export function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

/**
 * Fetch the server-rendered tiles for a document. `base` is the server's path
 * prefix — "" for solution.md, "/assignment" for the assignment reader.
 */
export async function fetchTiles(base = "", query = ""): Promise<TilesResult> {
    const res = await fetch(`${MARKDOWN_SERVER_URL}${base}/tiles${query}`);
    if (!res.ok) throw new Error(`tiles HTTP ${res.status}`);
    const json = (await res.json()) as TilesResponse;
    const pages: TilePage[] = json.pages.map((p) => ({
        tiles: p.tiles.map((t) => ({ index: t.index, bytes: base64ToBytes(t.data) })),
    }));
    return { version: json.version, pages, overlay: json.overlay ?? null };
}

/** Static geometry for the four image containers on a page. */
export function tileLayout(): { index: number; x: number; y: number }[] {
    const layout: { index: number; x: number; y: number }[] = [];
    for (let ty = 0; ty < TILES_Y; ty++) {
        for (let tx = 0; tx < TILES_X; tx++) {
            layout.push({ index: ty * TILES_X + tx, x: tx * TILE_W, y: ty * TILE_H });
        }
    }
    return layout;
}
