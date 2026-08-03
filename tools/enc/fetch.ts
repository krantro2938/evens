// Pulling the course off the web, exactly once.
//
// The source is https://matesspace.h1n.ru — one person's site on a Russian
// shared host, with no archive and no guarantee it will answer tomorrow. The
// pack has to stay rebuildable after it stops, so everything fetched lands in
// `cache/` and `cache/` is COMMITTED. It is ~1.4 MB of HTML and JPEG, which is
// a cheap price for a build that still runs when the origin is gone.
//
// Nothing here runs on the phone. This is a dev-machine step whose whole output
// is content/enc, and that is what ships.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const ORIGIN = "https://matesspace.h1n.ru/articles/maga";
export const CACHE = join(import.meta.dir, "cache");

/**
 * The articles, in the order maga0's own table of contents lists them.
 *
 * Numbering is the site's and it is not contiguous: maga9 is "остальные задачи
 * демовариантов" and sits at the END of the contents page even though its
 * number falls in the middle, and there is no maga18. Keeping the site's ids
 * means a node id can always be traced back to a URL, which is the only way to
 * check a conversion against the original.
 */
export const ARTICLES = [
    // Алгебра и геометрия
    1, 2, 3, 4, 5, 6, 7, 8,
    // Математический анализ
    10, 11, 12, 13, 14, 15, 16,
    // Дифференциальные уравнения
    17,
    // Остальные задачи демовариантов
    9,
] as const;

export type ArticleNo = (typeof ARTICLES)[number];

const articleUrl = (n: number) => `${ORIGIN}/maga${n}/maga${n}.php`;
const articlePath = (n: number) => join(CACHE, `maga${n}.html`);

/** Where a figure referenced by an article is cached. Figures are per-article
 *  relative paths ("1.jpg"), and two articles both have a "1.jpg". */
export const figurePath = (n: number, src: string) =>
    join(CACHE, "img", `maga${n}`, src.replace(/[^\w.-]/g, "_"));

const figureUrl = (n: number, src: string) => `${ORIGIN}/maga${n}/${src}`;

async function download(url: string, to: string): Promise<boolean> {
    await mkdir(dirname(to), { recursive: true });
    const res = await fetch(url, {
        // The host is slow and occasionally just stops answering; without a
        // deadline a fetch step can hang the whole build indefinitely.
        signal: AbortSignal.timeout(30_000),
        headers: { "user-agent": "evens-enc-packer (offline study pack)" },
    });
    if (!res.ok) {
        console.warn(`  ! ${url} -> HTTP ${res.status}`);
        return false;
    }
    await writeFile(to, Buffer.from(await res.arrayBuffer()));
    return true;
}

/**
 * Fill the cache. Skips anything already there, so a re-run is free and a
 * partially-failed run resumes rather than starting over.
 *
 * `force` re-downloads regardless, for the day the site is updated.
 */
export async function fetchAll(force = false): Promise<void> {
    await mkdir(CACHE, { recursive: true });

    for (const n of ARTICLES) {
        const to = articlePath(n);
        if (!force && existsSync(to)) continue;
        console.log(`  fetching maga${n}`);
        await download(articleUrl(n), to);
    }

    // Figures come second because their names are only discoverable by reading
    // the HTML that references them.
    for (const n of ARTICLES) {
        const html = await readArticle(n);
        for (const src of figureSources(html)) {
            const to = figurePath(n, src);
            if (!force && existsSync(to)) continue;
            console.log(`  fetching maga${n}/${src}`);
            await download(figureUrl(n, src), to);
        }
    }
}

/** Every `src` an <img> in the article body points at. */
export function figureSources(html: string): string[] {
    const out = new Set<string>();
    for (const m of html.matchAll(/<img[^>]+src="([^"]+)"/g)) {
        // Only article-local figures. The page chrome links absolute icons that
        // are not content and would just add bytes to the cache.
        if (!/^https?:|^\//.test(m[1])) out.add(m[1]);
    }
    return [...out];
}

export async function readArticle(n: number): Promise<string> {
    const path = articlePath(n);
    if (!existsSync(path)) {
        throw new Error(
            `maga${n} is not cached (${path}). Run with --fetch while the site is up.`,
        );
    }
    return readFile(path, "utf8");
}
