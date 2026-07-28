// Rendered tiles, kept on the phone.
//
// THREE THINGS THIS BUYS, in the order they matter:
//
//   1. A document you have already seen costs NOTHING to show again. Tiles are
//      keyed by the server's own version — a content hash — so "have I got this
//      exact document?" is answerable without asking the server, and reopening
//      the AI page after a walk down the corridor is instant instead of a
//      round trip and a four-tile render.
//   2. When the link drops, the glasses still have something to draw. Until now
//      a failed fetch fell through to text mode, which is a different, worse
//      page; now the last tiles you actually saw come back, and the footer says
//      how old they are.
//   3. The server renders less. A page of transcription is ~1-2s of Chromium,
//      and several glasses looking at the same assignment used to pay for it
//      each time one of them reconnected.
//
// WHY INDEXEDDB AND NOT THE TERMUX SERVER. The phone-side bridge would work,
// but it makes the glasses' ability to redraw a page depend on a script you
// have to remember to start — and the case this exists for is precisely the one
// where things are already not working. IndexedDB is on the device, needs no
// setup, survives a reload and a reboot, and holds tens of megabytes where
// localStorage holds five. A WebView without it degrades to an in-memory map,
// which still covers "don't refetch the page you are looking at".
//
// The camera preview is deliberately NOT cached. Its whole value is being about
// now; a stale frame is worse than no frame, and the Camera page already says
// so in its footer.

import { appLog } from "../debug";
import type { TilePage } from "./tiles";

const DB_NAME = "evens-tiles";
const DB_VERSION = 1;
const STORE = "tiles";

/**
 * How long a cached document stays usable.
 *
 * The ask was "at least five hours". This is longer on purpose: the point of
 * the cache is the afternoon where the wifi is bad, and a document that expired
 * at hour five would drop out exactly when it had been most useful. Age is not
 * really the constraint anyway — the tiles are keyed by content hash, so a
 * stale entry is never *wrong*, only old, and what actually bounds this cache
 * is MAX_ENTRIES below.
 */
export const TILE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * How many document versions to keep, newest first.
 *
 * A four-tile page is ~8KB and a long document is a handful of pages, so this
 * is a few megabytes at worst — well inside IndexedDB's budget, and enough to
 * hold every version of an assignment a scan produced plus the solutions that
 * answered them.
 */
const MAX_ENTRIES = 40;

export interface CachedTiles {
    pages: TilePage[];
    version: number;
    /** When it was stored, so a caller can say "3h ago" rather than lie. */
    at: number;
}

interface Row extends CachedTiles {
    key: string;
    /** Everything under one document, for eviction and newest-first lookup. */
    doc: string;
}

/** One document's identity: which endpoint, with which query. */
function docKey(base: string, query: string): string {
    return `${base || "/"}${query || ""}`;
}

function rowKey(base: string, query: string, version: number): string {
    return `${docKey(base, query)}#${version}`;
}

// ── the store ───────────────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
        try {
            if (typeof indexedDB === "undefined") return resolve(null);
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const store = db.createObjectStore(STORE, { keyPath: "key" });
                    // Newest-first lookup within one document, which is what an
                    // offline open needs: "whatever you last had for this page".
                    store.createIndex("doc_at", ["doc", "at"]);
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => {
                appLog("TileCache", "indexedDB unavailable", request.error?.message);
                resolve(null);
            };
            // Some WebViews open the database and then never fire either event.
            // A cache that hangs is worse than no cache: every read below awaits
            // this, and the page would sit blank behind it.
            setTimeout(() => resolve(null), 2_000);
        } catch (err) {
            appLog("TileCache", "indexedDB threw", err);
            resolve(null);
        }
    });
    return dbPromise;
}

/** Whatever IndexedDB can't do, this does — for the current session only. */
const memory = new Map<string, Row>();

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
    return db.transaction(STORE, mode).objectStore(STORE);
}

function promisify<T>(request: IDBRequest<T>): Promise<T | null> {
    return new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
    });
}

// ── reading ─────────────────────────────────────────────────────────────────

function fresh(row: Row | null | undefined): CachedTiles | null {
    if (!row || !row.pages?.length) return null;
    if (Date.now() - row.at > TILE_TTL_MS) return null;
    return { pages: row.pages, version: row.version, at: row.at };
}

/**
 * The tiles for one exact version, if they are already here.
 *
 * This is the call that removes the round trip: the client learns the version
 * from the status stream, and a hit means it never asks for the tiles at all.
 */
export async function recall(
    base: string,
    query: string,
    version: number,
): Promise<CachedTiles | null> {
    const key = rowKey(base, query, version);
    const inMemory = fresh(memory.get(key));
    if (inMemory) return inMemory;

    const db = await openDb();
    if (!db) return null;
    try {
        const row = await promisify<Row>(tx(db, "readonly").get(key) as IDBRequest<Row>);
        const hit = fresh(row);
        if (hit && row) memory.set(key, row);
        return hit;
    } catch (err) {
        appLog("TileCache", "recall failed", err);
        return null;
    }
}

/**
 * The newest tiles held for a document, whatever version they are.
 *
 * What an offline start uses. The version comes back with them, so the caller
 * can tell whether the server later disagrees rather than assuming it won't.
 */
export async function recallNewest(base: string, query: string): Promise<CachedTiles | null> {
    const doc = docKey(base, query);

    let best: Row | null = null;
    for (const row of memory.values()) {
        if (row.doc === doc && (!best || row.at > best.at)) best = row;
    }
    const inMemory = fresh(best);
    if (inMemory) return inMemory;

    const db = await openDb();
    if (!db) return null;
    try {
        const index = tx(db, "readonly").index("doc_at");
        // Descending over [doc, at] gives the newest entry for this document in
        // one hop, rather than reading every version to compare timestamps.
        const range = IDBKeyRange.bound([doc, -Infinity], [doc, Infinity]);
        const cursor = await promisify(index.openCursor(range, "prev"));
        return fresh((cursor?.value as Row) ?? null);
    } catch (err) {
        appLog("TileCache", "recallNewest failed", err);
        return null;
    }
}

// ── writing ─────────────────────────────────────────────────────────────────

export async function remember(
    base: string,
    query: string,
    version: number,
    pages: TilePage[],
): Promise<void> {
    if (!pages.length) return;
    const row: Row = {
        key: rowKey(base, query, version),
        doc: docKey(base, query),
        version,
        pages,
        at: Date.now(),
    };
    memory.set(row.key, row);

    const db = await openDb();
    if (!db) return;
    try {
        // Uint8Array survives the structured clone as-is, so the tiles are
        // stored decoded — smaller than the base64 they arrived as, and no
        // decode on the way back out.
        tx(db, "readwrite").put(row);
        void prune(db);
    } catch (err) {
        appLog("TileCache", "remember failed", err);
    }
}

/** Drop anything expired, then anything past MAX_ENTRIES, oldest first. */
async function prune(db: IDBDatabase): Promise<void> {
    try {
        const store = tx(db, "readwrite");
        const rows = await promisify<Row[]>(store.getAll() as IDBRequest<Row[]>);
        if (!rows) return;

        const cutoff = Date.now() - TILE_TTL_MS;
        const live = rows.filter((row) => row.at > cutoff);
        const dead = rows.filter((row) => row.at <= cutoff);
        const excess = live.sort((a, b) => b.at - a.at).slice(MAX_ENTRIES);

        for (const row of [...dead, ...excess]) {
            store.delete(row.key);
            memory.delete(row.key);
        }
    } catch (err) {
        appLog("TileCache", "prune failed", err);
    }
}

/** For the Setup page's "clear cached pages", and for tests. */
export async function clearTileCache(): Promise<void> {
    memory.clear();
    const db = await openDb();
    if (!db) return;
    try {
        tx(db, "readwrite").clear();
    } catch (err) {
        appLog("TileCache", "clear failed", err);
    }
}
