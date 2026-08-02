// Client side of tile rendering: the server (see /server) does the heavy
// markdown → PNG rasterization; here we just fetch the finished tiles, decode
// them, and hand geometry to the page builder. No marked/MathJax/html2canvas
// on-device anymore.

import { TILE_H, TILES_X, TILES_Y, TILE_W } from "../constants";
import { serverUrl } from "../services/backend";
import { appLog } from "../debug";
import { recall, recallNewest, remember } from "./tileCache";

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
    /**
     * When these tiles were cached, or null if they just came off the network.
     *
     * The page shows this in its footer. A stale document that looks live is
     * the failure this whole cache could otherwise introduce: the tiles are
     * never *wrong* — they are keyed by content hash — but "the assignment as
     * it was three hours ago" is a different claim from "the assignment".
     */
    cachedAt: number | null;
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
 *
 * Every success is written to the on-device cache, and a failure falls back to
 * it rather than to text mode: the last tiles you actually saw are a better
 * answer to "the wifi dropped" than a different, worse page. `cachedAt` is set
 * when that happened, so the caller can say how old they are instead of
 * presenting them as live. See render/tileCache.ts.
 */
export async function fetchTiles(base = "", query = ""): Promise<TilesResult> {
    try {
        const res = await fetch(`${serverUrl()}${base}/tiles${query}`);
        if (!res.ok) throw new Error(`tiles HTTP ${res.status}`);
        const json = (await res.json()) as TilesResponse;
        const pages: TilePage[] = json.pages.map((p) => ({
            tiles: p.tiles.map((t) => ({ index: t.index, bytes: base64ToBytes(t.data) })),
        }));
        // Not awaited: the tiles are ready to push now, and a slow write must
        // not sit between the document arriving and it reaching the panel.
        void remember(base, query, json.version, pages);
        return { version: json.version, pages, overlay: json.overlay ?? null, cachedAt: null };
    } catch (err) {
        const cached = await recallNewest(base, query);
        if (!cached) throw err;
        appLog("Tiles", "fetch failed, using cached tiles from", new Date(cached.at).toISOString());
        // No overlay: the cache holds the plain document, and claiming a
        // reserved rect we haven't got would leave the menu unreadable over the
        // text it failed to cover.
        return { version: cached.version, pages: cached.pages, overlay: null, cachedAt: cached.at };
    }
}

/**
 * The tiles for one exact version, without touching the network.
 *
 * The client knows the version from the status stream, so a hit here means the
 * document you already have is the document the server would send — and the
 * whole fetch-render-push round trip is skipped.
 */
export async function cachedTiles(
    base: string,
    query: string,
    version: number,
): Promise<TilesResult | null> {
    const hit = await recall(base, query, version);
    return hit
        ? { version: hit.version, pages: hit.pages, overlay: null, cachedAt: hit.at }
        : null;
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
