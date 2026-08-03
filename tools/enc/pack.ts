// The tree, the pages, and the search index — everything the phone ships with.
//
// Written as content/enc/, which is committed and served verbatim by both
// backends (server/enc.ts and offline/encyclopedia.py). Neither of them renders
// anything or knows what a node is; they read a file and return it. That is the
// whole reason this works with no network and no Chromium on the phone.

import { gzipSync } from "node:zlib";
import { join } from "node:path";
import type { Page } from "./paginate";
import { SECTIONS, type Topic } from "./syllabus";
import { translit } from "./translit";
import { writeOut } from "./images";

export const OUT_ROOT = join(import.meta.dir, "..", "..", "content", "enc");

export interface TocNode {
    /** Russian, as shown. */
    title: string;
    /** Transliterated, for the Setup toggle's Latin mode. */
    lat: string;
    /** Branch nodes only. */
    children?: string[];
    /** Leaf nodes only: how many pages, so the pager can say "3 / 7". */
    pages?: number;
    /** Leaf nodes only, for the icon-less list to still say what a row is. */
    kind?: "theory" | "example" | "formulas" | "method" | "sheet";
}

export interface Toc {
    version: number;
    built: string;
    /**
     * An all-black 288×126 tile.
     *
     * A text page still has four image containers under it, and whatever the
     * previous page left there stays on screen. Pushing this to all four is how
     * a text page gets a background — and because the client's tile pusher
     * dedupes by bytes, walking through ten text pages costs one push, not
     * forty.
     */
    blank: string;
    nodes: Record<string, TocNode>;
    /** term -> node ids, for matching the scanned assignment. */
    index: Record<string, string[]>;
}

export interface Leaf {
    id: string;
    title: string;
    label: string;
    kind: NonNullable<TocNode["kind"]>;
    /** Which article it came from, or null for authored-only nodes. */
    article: number | null;
    pages: Page[];
    /** Words this node should be findable by. */
    terms: string[];
}

/**
 * A node file is content-addressed by a hash of its pages.
 *
 * The same trick server/docs.ts uses, for the same reason: the client caches by
 * version, and static content means a version that never moves, which means a
 * node fetched once is never fetched again. It also means an edit to one node
 * invalidates that node and nothing else.
 */
function hashPages(pages: Page[]): number {
    let h = 2166136261;
    const text = JSON.stringify(pages);
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/** Words worth indexing: no stopwords, no one-letter variables. */
const STOP = new Set([
    "и", "в", "на", "с", "по", "для", "из", "или", "то", "как", "что", "это",
    "если", "при", "все", "его", "её", "их", "не", "но", "а", "же", "бы",
    "быть", "есть", "был", "была", "было", "будет", "также", "тогда", "так",
    "где", "чем", "чтобы", "этот", "эта", "эти", "тот", "та", "те", "один",
    "два", "три", "первый", "второй", "задача", "задание", "решение", "пример",
    "условие", "ответ", "проверка", "теория", "формула", "формулы",
]);

function terms(text: string): string[] {
    return [
        ...new Set(
            text
                .toLowerCase()
                .replace(/[^\p{L}\p{N}\s-]/gu, " ")
                .split(/\s+/)
                // Russian is inflected and there is no stemmer here; a prefix
                // of six characters is what makes "интегралов" and "интеграл"
                // the same term without one.
                .filter((w) => w.length >= 4 && !STOP.has(w))
                .map((w) => w.slice(0, 6)),
        ),
    ];
}

export interface Built {
    topicNodes: Map<number, Leaf[]>;
    /** The global Шпаргалка, if authored. */
    sheet: Leaf | null;
}

export async function writePack(built: Built): Promise<{ bytes: number; leaves: number }> {
    const nodes: Record<string, TocNode> = {};
    const index: Record<string, Set<string>> = {};
    const files: { id: string; json: string }[] = [];
    let leaves = 0;

    const addLeaf = (leaf: Leaf) => {
        leaves++;
        nodes[leaf.id] = {
            title: leaf.label,
            lat: translit(leaf.label),
            pages: leaf.pages.length,
            kind: leaf.kind,
        };
        files.push({
            id: leaf.id,
            json: JSON.stringify({
                id: leaf.id,
                title: leaf.title,
                version: hashPages(leaf.pages),
                pages: leaf.pages,
            }),
        });
        for (const term of leaf.terms) (index[term] ??= new Set()).add(leaf.id);
    };

    const rootChildren: string[] = [];

    for (const section of SECTIONS) {
        const topicIds: string[] = [];
        for (const topic of section.topics) {
            const leafList = built.topicNodes.get(topic.no) ?? [];
            if (!leafList.length) continue;
            const id = `m${topic.no}`;
            for (const leaf of leafList) addLeaf(leaf);
            nodes[id] = {
                title: topic.short,
                lat: translit(topic.short),
                children: leafList.map((l) => l.id),
            };
            topicIds.push(id);
            // The topic itself is what the assignment matcher points at, so its
            // hand-written keywords are indexed against the topic id and the
            // first node under it.
            for (const term of topicTerms(topic)) (index[term] ??= new Set()).add(id);
        }
        if (!topicIds.length) continue;
        nodes[section.id] = {
            title: section.title,
            lat: translit(section.title),
            children: topicIds,
        };
        rootChildren.push(section.id);
    }

    if (built.sheet) {
        addLeaf(built.sheet);
        // Above the sections: it is the one node you open without knowing which
        // topic you are in.
        rootChildren.unshift(built.sheet.id);
    }

    nodes.root = { title: "Справочник", lat: "Spravochnik", children: rootChildren };

    const toc: Toc = {
        version: 1,
        built: new Date().toISOString().slice(0, 10),
        blank: await blankTile(),
        nodes,
        index: Object.fromEntries(
            Object.entries(index)
                // A term that points at half the encyclopedia ranks nothing.
                .filter(([, ids]) => ids.size <= 8)
                .map(([term, ids]) => [term, [...ids]]),
        ),
    };

    // Everything is stored GZIPPED and served with `content-encoding: gzip`,
    // so neither server ever decompresses it — they hand the bytes straight to
    // the client and `fetch` unwraps them. That is a third off the pack for no
    // code on the phone, and it is why there is no bundle file: a "download
    // everything" endpoint would be the one thing that had to unpack these
    // again, and the client can simply fetch the nodes it is going to cache
    // anyway.
    let bytes = 0;
    const write = async (path: string, json: string) => {
        const gz = gzipSync(Buffer.from(json), { level: 9 });
        await writeOut(join(OUT_ROOT, path), gz);
        bytes += gz.length;
    };

    await write("toc.json.gz", JSON.stringify(toc));
    for (const file of files) await write(`pages/${file.id}.json.gz`, file.json);

    return { bytes, leaves };
}

const topicTerms = (topic: Topic): string[] => [
    ...terms(topic.short),
    ...topic.keywords.flatMap((k) => terms(k)),
];

export const leafTerms = (title: string, label: string, extra = ""): string[] =>
    terms(`${title} ${label} ${extra}`);

/** A single all-black tile, produced by the same encoder the pages use. */
async function blankTile(): Promise<string> {
    const { encodeTile } = await import("../../server/render/tiles");
    return (await encodeTile([])).toString("base64");
}
