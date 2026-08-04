// Build content/enc from the cached course plus the authored extras.
//
//   bun run build.ts              rebuild the pack from the cache
//   bun run build.ts --fetch      refresh the cache from the site first
//   bun run build.ts --check-only report on the conversion, write nothing
//   bun run build.ts --only m13   one topic, for iterating on a conversion bug
//
// Runs on a developer machine and nowhere else. Its output is the only thing
// that ships.

import { ARTICLES, fetchAll, readArticle } from "./fetch";
import { closeDom, parseMain } from "./dom";
import { convertArticle, type Block } from "./convert";
import { splitArticle } from "./split";
import { paginate, isTextSafe } from "./paginate";
import { packFigure } from "./images";
import { loadAuthored } from "./authored";
import { leafTerms, writePack, type Built, type Leaf } from "./pack";
import { SECTIONS, topicOf } from "./syllabus";
import { closeBrowser } from "./render";
import { auditPages, checkBlocks, report, type Finding } from "./check";
import { mirror } from "./mirror";

const args = new Set(process.argv.slice(2));
const only = (() => {
    const i = process.argv.indexOf("--only");
    return i >= 0 ? process.argv[i + 1] : null;
})();

const CHECK_ONLY = args.has("--check-only");

/** Slot order inside a topic. Формулы first: it is what you open under time. */
const SLOT_ORDER = ["formulas", "method", "theory"] as const;
const SLOT_TITLE: Record<string, string> = {
    formulas: "Формулы",
    method: "Как решать",
    theory: "Теория",
};

async function main(): Promise<void> {
    if (args.has("--fetch")) {
        console.log("Fetching the course…");
        await fetchAll(args.has("--force"));
    }

    const authored = await loadAuthored();
    console.log(`Authored files: ${authored.length}`);

    const findings: Finding[] = [];
    const topicNodes = new Map<number, Leaf[]>();
    let textPages = 0;
    let tilePages = 0;

    for (const no of ARTICLES) {
        if (only && only !== `m${no}`) continue;
        const topic = topicOf(no);
        if (!topic) {
            console.warn(`  ! maga${no} is not in the syllabus — skipped`);
            continue;
        }

        const article = convertArticle(no, await parseMain(await readArticle(no)));
        const scraped = splitArticle(no, article.blocks);
        findings.push(...checkBlocks(`maga${no}`, article.blocks));

        // Figures are compressed once per article, before anything is rendered:
        // the markdown embeds them as data URIs and cannot wait on a subprocess.
        const missing = new Set<string>();
        for (const b of article.blocks) {
            if (b.kind !== "figure") continue;
            if (!(await packFigure(no, b.figure.src))) missing.add(b.figure.src);
        }
        if (missing.size) {
            findings.push({
                where: `maga${no}`,
                what: `${missing.size} figure(s) not in the cache: ${[...missing].join(", ")}`,
            });
        }

        const leaves: Leaf[] = [];

        // Authored slots come first in the list, so the two most useful pages
        // in a topic are the two nearest the top of it.
        for (const slot of SLOT_ORDER) {
            const doc = authored.find((a) => a.topic === `m${no}` && a.slot === slot);
            if (!doc) continue;
            findings.push(...checkBlocks(`authored/m${no}.${slot}`, doc.blocks));
            leaves.push({
                id: `m${no}.${slot[0]}`,
                title: doc.title,
                label: SLOT_TITLE[slot],
                kind: slot as Leaf["kind"],
                article: no,
                pages: CHECK_ONLY ? [] : await paginate(doc.blocks, no),
                terms: leafTerms(doc.title, SLOT_TITLE[slot]),
            });
        }

        for (const node of scraped) {
            leaves.push({
                id: node.id,
                title: node.title,
                label: node.label,
                kind: node.kind,
                article: no,
                pages: CHECK_ONLY ? [] : await paginate(node.blocks, no),
                terms: leafTerms(node.title, node.label, textOf(node.blocks)),
            });
        }

        for (const leaf of leaves) {
            for (const page of leaf.pages) {
                if (page.kind === "text") textPages++;
                else tilePages++;
            }
            // Checked on the finished pages, not on the blocks: whether a page
            // fits the panel and whether the font can draw it are properties of
            // the output, and both fail silently on the glasses.
            findings.push(...auditPages(leaf.id, leaf.pages));
        }

        topicNodes.set(no, leaves);
        const split = leaves.flatMap((l) => l.pages);
        console.log(
            `  maga${String(no).padStart(2)} ${topic.short.padEnd(34)} ` +
                `${String(leaves.length).padStart(2)} nodes  ${String(split.length).padStart(3)} pages`,
        );
    }

    // The global sheet, which belongs to no topic.
    const sheetDoc = authored.find((a) => a.topic === "sheet");
    let sheet: Leaf | null = null;
    if (sheetDoc) {
        findings.push(...checkBlocks("authored/sheet", sheetDoc.blocks));
        sheet = {
            id: "sheet",
            title: sheetDoc.title,
            label: "Шпаргалка",
            kind: "sheet",
            article: null,
            pages: CHECK_ONLY ? [] : await paginate(sheetDoc.blocks, 0),
            terms: leafTerms(sheetDoc.title, "Шпаргалка"),
        };
        for (const page of sheet.pages) page.kind === "text" ? textPages++ : tilePages++;
        findings.push(...auditPages("sheet", sheet.pages));
    }

    report(findings);

    if (CHECK_ONLY) {
        console.log("\n--check-only: nothing written.");
        return;
    }

    const built: Built = { topicNodes, sheet };
    const { bytes, leaves } = await writePack(built);

    const total = textPages + tilePages;
    console.log(
        `\nPack: ${leaves} nodes, ${total} pages ` +
            `(${textPages} text / ${tilePages} tiles, ${pct(textPages, total)} text)`,
    );
    console.log(`      ${(bytes / 1024).toFixed(0)} KB of JSON in content/enc/`);
    // Here rather than as a step to remember: the phone reads its own copy, and
    // a copy that is only refreshed when someone thinks of it is a copy that is
    // silently a version behind at the moment it matters.
    console.log(`      ${await mirror()}`);
    if (only) console.log("      (partial build — --only was set)");
    if (!only) {
        const covered = new Set([...topicNodes.keys()]);
        const expected = SECTIONS.flatMap((s) => s.topics.map((t) => t.no));
        const gaps = expected.filter((n) => !covered.has(n));
        if (gaps.length) console.warn(`      MISSING TOPICS: ${gaps.join(", ")}`);
    }
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "0%");

/** A node's prose, for the search index. Maths contributes nothing searchable. */
function textOf(blocks: Block[]): string {
    return blocks
        .map((b) => ("text" in b ? b.text.replace(/\$[^$]*\$/g, " ") : ""))
        .join(" ");
}

try {
    await main();
} finally {
    await closeDom();
    await closeBrowser();
}
