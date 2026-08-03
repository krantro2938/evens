// The encyclopedia, served as the bytes it already is.
//
// Every other document on this server is rendered on request: markdown comes in
// and Chromium turns it into tiles. This one never is. The course is static, so
// it was rendered once by tools/enc on a developer machine and committed to
// content/enc — and all this does is read a file and hand it back.
//
// That is the design, not an optimisation. The same pack is served by
// offline/encyclopedia.py on the phone, and that machine has no Chromium, no
// MathJax and, at the moment it matters most, no network. A renderer here would
// be a second implementation the offline one could never match, and the glasses
// would show a different encyclopedia depending on which server answered.
//
// The files on disk are already gzipped and go out with `content-encoding:
// gzip` — so this never decompresses anything either. `fetch` unwraps them in
// the client, which is the one place that was always going to hold the JSON.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the pack lives.
 *
 * Overridable because the server runs from a container whose working directory
 * is not the repo (see docker-compose.yml), and the pack is mounted rather than
 * baked into the image — it is content, and it changes on a different schedule
 * to the code.
 */
const ROOT = process.env.ENC_DIR ?? join(import.meta.dir, "..", "content", "enc");

/** Node ids are filenames. Anything that isn't one of these is not a node. */
const ID = /^[a-z0-9.]{1,40}$/i;

export const encAvailable = (): boolean => existsSync(join(ROOT, "toc.json.gz"));

/**
 * Read-through cache of the whole pack.
 *
 * The pack is a few megabytes and never changes while the process is up, so
 * every node is read from disk exactly once. Without it, paging a document
 * would hit the filesystem on every swipe — fine on a VPS, and not fine in
 * Termux on a phone, and the two servers should behave the same.
 */
const cache = new Map<string, Buffer | null>();

async function readCached(path: string): Promise<Buffer | null> {
    const hit = cache.get(path);
    if (hit !== undefined) return hit;
    const data = existsSync(path) ? await readFile(path) : null;
    cache.set(path, data);
    return data;
}

/** The tree: sections, topics, node titles, page counts, the search index. */
export const readToc = (): Promise<Buffer | null> => readCached(join(ROOT, "toc.json.gz"));

/** One node's pages, already rendered. */
export async function readNode(id: string): Promise<Buffer | null> {
    // A node id becomes a path, so it is validated rather than sanitised: the
    // set of legal ids is small and known, and "reject what isn't one" cannot
    // be got subtly wrong the way stripping "../" can.
    if (!ID.test(id) || id.includes("..")) return null;
    return readCached(join(ROOT, "pages", `${id}.json.gz`));
}
