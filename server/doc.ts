// A "document source" is anything that can produce markdown and say when it
// changed. Everything downstream — the markdown → PNG tile pipeline, the tile
// cache, the SSE fan-out — is written against this interface, so adding a
// second document (the assignment reader) costs no rendering code at all.

import { renderTiles, type TilePage } from "./render/tiles";

export interface Snapshot {
    content: string;
    /**
     * Changes if and only if the content changed; the client refetches tiles
     * when it advances. For a file that's the mtime, for a remote document a
     * content hash.
     */
    version: number;
}

export interface DocSource {
    /** Used in log lines and to key the tile cache. */
    name: string;
    read(): Promise<Snapshot>;
    /** Register a change listener. Returns an unsubscribe. */
    subscribe(onChange: () => void): () => void;
}

export interface TilesResult {
    version: number;
    pages: TilePage[];
}

/**
 * Rendering is ~1-2s of headless Chromium, so cache by version and dedupe
 * concurrent requests — a burst of glasses clients renders once. One cache per
 * source; they hold different documents and their versions are unrelated.
 */
export function createTileCache(source: DocSource): () => Promise<TilesResult> {
    let cache: TilesResult | null = null;
    let inFlight: Promise<TilesResult> | null = null;

    return async function getTiles(): Promise<TilesResult> {
        const { content, version } = await source.read();
        if (cache?.version === version) return cache;
        if (inFlight) return inFlight;

        inFlight = (async () => {
            const started = Date.now();
            const pages = await renderTiles(content);
            const result: TilesResult = { version, pages };
            cache = result;
            console.log(
                `[${source.name}] rendered ${pages.length} tile-pages in ${Date.now() - started}ms (v${version})`,
            );
            return result;
        })();
        try {
            return await inFlight;
        } finally {
            inFlight = null;
        }
    };
}

/**
 * FNV-1a. Used as the `version` for sources with no natural one: two fetches of
 * an unchanged document must hash equal, so the tile cache holds and we don't
 * re-render (or re-push over BLE) on every capture that changed nothing.
 */
export function hashContent(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
