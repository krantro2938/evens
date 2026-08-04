// The study pack on the phone: fetch it once, keep it forever.
//
// This is a SECOND, separate store from render/tileCache.ts, and the difference
// is the whole reason it exists. That cache is a 12-hour, 40-entry LRU over
// documents that change — a solution supersedes the one before it, and holding
// every version would fill the disk with history nobody asked for. The
// encyclopedia is the opposite: 151 nodes that will never change, each keyed by
// a hash of its own content, and the moment worth optimising for is an exam
// room with no signal. Sharing that LRU would mean the pack evicting itself
// between sessions, and evicting the assignment you were reading to do it.
//
// So: no TTL, no eviction, ~4 MB, and "Download encyclopedia" in Setup fills it
// in one go. After that the encyclopedia works with the document server down,
// Termux not running, and the phone in aeroplane mode.

import { DOC_BASE_ENC } from "../constants";
import { docFetch } from "../services/backend";
import { appLog } from "../debug";

const DB_NAME = "evens-enc";
const DB_VERSION = 1;
const STORE = "nodes";
/** The tree is stored under the same key space as the nodes; it has no id. */
const TOC_KEY = "\0toc";

// ── the shapes the packer writes (see tools/enc/pack.ts) ───────────────────

export interface TocNode {
    title: string;
    /** Transliterated, for the Setup toggle's Latin mode. */
    lat: string;
    children?: string[];
    pages?: number;
    kind?: "theory" | "example" | "formulas" | "method" | "sheet";
}

export interface Toc {
    version: number;
    built: string;
    /** An all-black tile, pushed under a text page. See reader.ts. */
    blank: string;
    nodes: Record<string, TocNode>;
    index: Record<string, string[]>;
}

export type EncPage =
    | { kind: "text"; text: string }
    /** Four base64 PNGs, row-major, matching ENC_TILE_IDS. */
    | { kind: "tiles"; tiles: string[] };

export interface EncNodeDoc {
    id: string;
    title: string;
    version: number;
    pages: EncPage[];
}

// ── storage ────────────────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
        if (typeof indexedDB === "undefined") return resolve(null);
        let request: IDBOpenDBRequest;
        try {
            request = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (err) {
            appLog("enc", "indexedDB.open threw", err);
            return resolve(null);
        }
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
            appLog("enc", "indexedDB unavailable", request.error);
            resolve(null);
        };
    });
    return dbPromise;
}

/**
 * The in-memory tier, in front of IndexedDB.
 *
 * Paging a node re-reads it on every swipe, and an IndexedDB round trip per
 * page turn is latency on the one gesture that has to feel immediate. A node
 * is at most a few hundred KB and the map holds whatever this visit touched.
 */
const memory = new Map<string, unknown>();

async function get<T>(key: string): Promise<T | null> {
    const hit = memory.get(key);
    if (hit !== undefined) return hit as T;

    const db = await openDb();
    if (!db) return null;
    const value = await new Promise<T | null>((resolve) => {
        try {
            const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
            req.onsuccess = () => resolve((req.result as T) ?? null);
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
    if (value !== null) memory.set(key, value);
    return value;
}

async function put(key: string, value: unknown): Promise<void> {
    memory.set(key, value);
    const db = await openDb();
    if (!db) return;
    await new Promise<void>((resolve) => {
        try {
            const tx = db.transaction(STORE, "readwrite");
            tx.objectStore(STORE).put(value, key);
            tx.oncomplete = () => resolve();
            // A full disk is not worth failing a page render over — the memory
            // tier still has it for this session.
            tx.onerror = () => resolve();
        } catch {
            resolve();
        }
    });
}

// ── fetching ───────────────────────────────────────────────────────────────

/**
 * Why the last fetch failed.
 *
 * Logged is not good enough for one caller: Setup's download has a person
 * standing in front of it, and the two ways it fails need different things
 * done about them. A 503 means the server is up and has no pack — the study
 * pack was never checked out (offline/setup-termux.sh) or never mounted
 * (docker-compose.yml). Anything else means nothing answered at all. From the
 * outside both look like zero pages downloaded.
 */
let lastFailure = "";

async function fetchJson<T>(path: string): Promise<T | null> {
    try {
        const res = await docFetch(path);
        if (!res.ok) {
            appLog("enc", `${path} -> ${res.status}`);
            lastFailure = String(res.status);
            return null;
        }
        // The server sends pre-gzipped bytes with content-encoding: gzip;
        // fetch unwraps them, so this is ordinary JSON by the time it is here.
        return (await res.json()) as T;
    } catch (err) {
        appLog("enc", `${path} failed`, err);
        lastFailure = "unreachable";
        return null;
    }
}

/**
 * The tree. Cached like a node, because it is one as far as storage cares —
 * and because a browser that cannot list its own contents offline is not
 * offline-capable, however many nodes it has stored.
 */
export async function loadToc(): Promise<Toc | null> {
    const cached = await get<Toc>(TOC_KEY);
    if (cached) return cached;
    const toc = await fetchJson<Toc>(`${DOC_BASE_ENC}/toc`);
    if (toc) await put(TOC_KEY, toc);
    return toc;
}

export async function loadNode(id: string): Promise<EncNodeDoc | null> {
    const cached = await get<EncNodeDoc>(id);
    if (cached) return cached;
    const node = await fetchJson<EncNodeDoc>(`${DOC_BASE_ENC}/node?id=${encodeURIComponent(id)}`);
    if (node) await put(id, node);
    return node;
}

/** Whether a node is already on the device — for the warm-up's progress. */
export async function isStored(id: string): Promise<boolean> {
    return (await get<EncNodeDoc>(id)) !== null;
}

/**
 * How many nodes to fetch at once during the warm-up.
 *
 * Enough to hide the round trip, few enough not to queue a hundred requests
 * against a Termux server that is single-threaded and may also be holding a
 * language model.
 */
const WARM_CONCURRENCY = 4;

export interface WarmProgress {
    done: number;
    total: number;
    failed: number;
    /**
     * Set when the tree itself never arrived, so nothing could even be
     * attempted. Distinct from `failed`, which counts nodes that were tried:
     * with no tree the totals are all zero, and reporting that as a failure
     * count made Setup print arithmetic on a sentinel ("-1 of 0") instead of
     * the one sentence that says what to go and fix.
     */
    error?: "no-pack" | "unreachable";
}

/**
 * Pull the whole pack down, so the encyclopedia survives everything going away.
 *
 * Node by node rather than as one bundle. It is more round trips, but it fills
 * exactly the store the reader reads from — a bundle would need its own
 * endpoint, its own format, and a decompression step on the phone, all to
 * populate the same rows these requests populate anyway.
 */
export async function warmAll(onProgress: (p: WarmProgress) => void): Promise<WarmProgress> {
    lastFailure = "";
    const toc = await loadToc();
    if (!toc) {
        return {
            done: 0,
            total: 0,
            failed: 0,
            // Any HTTP status at all means something answered, so the network
            // and the mode are fine and the pack is the thing missing. 503 is
            // the packed-in answer for "no pack"; a 404 is an older server
            // that predates these routes, which needs the same update anyway.
            error: lastFailure === "unreachable" ? "unreachable" : "no-pack",
        };
    }

    const ids = Object.entries(toc.nodes)
        .filter(([, node]) => node.pages)
        .map(([id]) => id);

    const progress: WarmProgress = { done: 0, total: ids.length, failed: 0 };
    let next = 0;

    const worker = async (): Promise<void> => {
        while (next < ids.length) {
            const id = ids[next++];
            if (!(await isStored(id)) && !(await loadNode(id))) progress.failed++;
            progress.done++;
            // Reported per node rather than per batch: this takes a minute or
            // two over a hotspot, and a progress line that only moves four
            // times a second is the difference between "working" and "hung".
            onProgress({ ...progress });
        }
    };

    await Promise.all(Array.from({ length: WARM_CONCURRENCY }, worker));
    return progress;
}
