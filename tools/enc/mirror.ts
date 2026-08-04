// Mirror the served half of the pack into offline/, so the phone gets it on a
// plain `git pull`.
//
//   bun run mirror.ts        (also runs at the end of build.ts)
//
// The pack is BUILT here, in evens, because this is where the renderer lives.
// But evens is a submodule of utils, and the phone clones utils — and a clone
// does not check submodules out. So on Termux content/enc was simply absent,
// encyclopedia.py resolved ROOT="" and /enc/* answered 503, which from the
// glasses looks like a download that fetched nothing.
//
// Fixing that with `git submodule update` means every future update is two
// commands and a thing to remember. Copying the bytes into the repo the phone
// already pulls means it is one command, forever. That is worth ~5MB.
//
// Only what the servers actually read is copied: toc.json.gz and pages/.
// img/ is figure sources that were inlined into the tiles at build time, and
// authored/ is the markdown I write — neither is ever served, and authored/
// especially must not be duplicated, or there are two copies of a source file
// and no way to tell which one someone edited.

import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "content", "enc");
/** utils/offline — the repo the phone clones. */
const DEST_ROOT = join(import.meta.dir, "..", "..", "..", "offline");
const DEST = join(DEST_ROOT, "content", "enc");

/** Exactly the files enc.ts and encyclopedia.py open. Nothing else travels. */
const SERVED = ["toc.json.gz", "pages"];

export async function mirror(): Promise<string> {
    if (!existsSync(join(SRC, "toc.json.gz"))) return "no pack to mirror";
    // Absent when evens is checked out on its own rather than inside utils,
    // which is a normal thing to do and not an error.
    if (!existsSync(DEST_ROOT)) return "no offline/ next door — skipped";

    await mkdir(join(DEST, "pages"), { recursive: true });

    // Stale pages are deleted rather than left: a node that a rebuild dropped
    // would otherwise stay readable on the phone forever, and the toc that no
    // longer lists it gives no hint that it is there.
    const live = new Set(await readdir(join(SRC, "pages")));
    let dropped = 0;
    for (const name of await readdir(join(DEST, "pages"))) {
        if (live.has(name)) continue;
        await rm(join(DEST, "pages", name));
        dropped++;
    }

    for (const entry of SERVED) {
        await cp(join(SRC, entry), join(DEST, entry), { recursive: true });
    }

    let bytes = 0;
    for (const name of live) bytes += (await stat(join(SRC, "pages", name))).size;
    bytes += (await stat(join(SRC, "toc.json.gz"))).size;

    return (
        `mirrored ${live.size} pages (${(bytes / 1024 / 1024).toFixed(1)} MB) to offline/content/enc` +
        (dropped ? ` — removed ${dropped} stale` : "")
    );
}

if (import.meta.main) console.log(await mirror());
