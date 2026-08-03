// One article -> the nodes you can actually navigate to.
//
// An article is 20 KB of prose and the panel shows 252 pixels at a time, so
// "open the article" is not a thing anyone would do mid-problem. The unit that
// matters is a section: the theory for one idea, or one worked problem with its
// answer. That is what this cuts, using the site's own headings — which are
// regular enough across all seventeen articles to be trusted (see the patterns
// in syllabus.ts).
//
// Two rules carry most of the weight:
//
//   - A worked problem is "Условие …" up to the next "Условие …", INCLUDING its
//     Решение / Проверка / Примечание subheadings. Condition and answer on
//     separate pages would be two half-nodes, and the answer is the reason you
//     opened it.
//   - A theory section that is long AND has subheadings is cut at those
//     instead. maga3's "Линии второго порядка" is 80 blocks; as one node it is
//     a dozen glasses pages you have to swipe through to reach the parabola.

import type { Block } from "./convert";
import {
    CONDITION_HEADING,
    DROP_SECTION,
    EXERCISES_HEADING,
    WITHIN_EXAMPLE,
} from "./syllabus";

export interface EncNode {
    /** Stable and traceable: "m13.t2" is article 13, third theory section. */
    id: string;
    title: string;
    /** Shown in the nav list; the title, shortened, or a problem's first line. */
    label: string;
    kind: "theory" | "example";
    blocks: Block[];
}

/** Roughly how much of the panel a block will take, for the long-section test. */
function weigh(b: Block): number {
    switch (b.kind) {
        case "heading":
            return b.text.length + 40;
        case "para":
        case "item":
            return b.text.length;
        case "math":
            return b.tex.length + 60;
        case "figure":
            return 400;
        case "table":
            return b.rows.flat().join("").length + 60;
    }
}

const weight = (blocks: Block[]) => blocks.reduce((n, b) => n + weigh(b), 0);

/** A theory section past this, with subheadings to cut at, is split. */
const SPLIT_ABOVE = 2_500;

/** Lead-in prose below this weight is folded into the subsection after it. */
const LEAD_IN_MAX = 400;

/**
 * A node past this is cut into numbered parts, headings or no headings.
 *
 * maga13's "Методы интегрирования" is the case that forces it: 113 blocks with
 * no subheading anywhere inside, which paginates to sixty-eight pages. That is
 * a coherent section and splitting it is a compromise — but sixty-eight pages
 * reachable only by swiping through them in order is not a reference, and there
 * is nothing else in the tree to jump to. Roughly fifteen pages a part.
 */
const MAX_NODE_WEIGHT = 5_000;

/** Nav rows fit about this many characters at the panel's body size. */
const LABEL_MAX = 44;

function shorten(text: string, max = LABEL_MAX): string {
    const clean = text
        // Markdown, undone: a nav row is plain text, and "\[4, с. 12\]" is
        // what an escaped citation looks like when nothing renders it.
        .replace(/\\([*_`[\]])/g, "$1")
        .replace(/\*\*/g, "")
        // What is left when a formula is lifted out of a sentence.
        .replace(/\s+([.,;:])/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
    if (clean.length <= max) return clean;
    // Cut on a word boundary — a label ending mid-word reads as a glitch.
    const cut = clean.slice(0, max - 1);
    const space = cut.lastIndexOf(" ");
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * A problem's label. "Условие задачи 1" says nothing about which problem it is,
 * and a list of six of those is a list you have to open one by one — so the
 * label is the problem itself, taken from the first thing it states.
 */
/**
 * Provenance, not problem. Most worked problems open by saying where they came
 * from ("Это задание взято из демонстрационного варианта 2019 года"), which is
 * true, useful in the article, and no help at all in a list of six problems you
 * are trying to tell apart.
 */
const PROVENANCE = /^\(?\s*(это|эта|данн|см\.|задани|задача)\b.{0,40}\b(взят|есть|из вариант|демонстрац|вар\.)/i;

function exampleLabel(index: number, blocks: Block[]): string {
    const first = blocks.find(
        (b) =>
            (b.kind === "para" || b.kind === "item") &&
            b.text.replace(/[^\p{L}]/gu, "").length > 12 &&
            !PROVENANCE.test(b.text),
    );
    const gist = first && "text" in first
        // Formulas are unreadable as raw TeX in a nav row, and the sentence
        // around them ("Найти аргумент комплексного числа") is the useful part.
        ? first.text.replace(/\$[^$]*\$/g, "").replace(/\s+/g, " ").trim()
        : "";
    return gist ? shorten(`${index}. ${gist}`) : `Задача ${index}`;
}

interface Section {
    heading: Block & { kind: "heading" };
    blocks: Block[];
}

export function splitArticle(no: number, blocks: Block[]): EncNode[] {
    // Everything before the first heading is the article's own preamble.
    const sections: Section[] = [];
    let lead: Block[] = [];

    for (const b of blocks) {
        if (b.kind === "heading" && b.level <= 2) {
            sections.push({ heading: b, blocks: [] });
            continue;
        }
        if (sections.length === 0) lead.push(b);
        else sections[sections.length - 1].blocks.push(b);
    }

    const nodes: EncNode[] = [];
    let theoryN = 0;
    let exampleN = 0;
    let inExercises = false;

    const pushTheory = (title: string, body: Block[]) => {
        if (!weight(body)) return;
        theoryN++;
        nodes.push({
            id: `m${no}.t${theoryN}`,
            title,
            label: shorten(title),
            kind: "theory",
            blocks: body,
        });
    };

    // A preamble with real content becomes the topic's opening node, so that
    // the sentence explaining what the topic IS is not stranded above the
    // first heading where nothing can reach it.
    if (weight(lead) > 200) pushTheory("Введение", lead);

    for (const section of sections) {
        const title = section.heading.text;
        if (DROP_SECTION.test(title)) continue;

        if (EXERCISES_HEADING.test(title)) {
            inExercises = true;
            // maga9 is nothing but problems and groups them under several
            // headings ("Задания 1", "Задания 2"); the heading itself carries
            // no content worth a node.
        }

        if (!inExercises) {
            // Cut at subheadings only when the section is big enough that not
            // cutting costs more than the extra nav level.
            const subs = section.blocks.filter((b) => b.kind === "heading" && b.level >= 3);
            if (subs.length >= 2 && weight(section.blocks) > SPLIT_ABOVE) {
                let current: Block[] = [];
                let currentTitle = title;
                for (const b of section.blocks) {
                    if (b.kind === "heading" && b.level >= 3) {
                        // A sentence or two of lead-in before the first
                        // subheading is not a section — it is the opening of
                        // the one that follows, and a nav entry that turns out
                        // to be one line costs more to visit than to read.
                        if (weight(current) < LEAD_IN_MAX) {
                            current.push({ kind: "heading", level: 3, text: b.text });
                            currentTitle = b.text;
                            continue;
                        }
                        pushTheory(currentTitle, current);
                        current = [];
                        currentTitle = b.text;
                        continue;
                    }
                    current.push(b);
                }
                pushTheory(currentTitle, current);
            } else {
                pushTheory(title, section.blocks);
            }
            continue;
        }

        // Exercises: one node per "Условие", swallowing the Решение and
        // Проверка that follow it.
        let current: Block[] | null = null;
        const flushExample = () => {
            if (!current || !weight(current)) {
                current = null;
                return;
            }
            exampleN++;
            nodes.push({
                id: `m${no}.e${exampleN}`,
                title: `Задача ${exampleN}`,
                label: exampleLabel(exampleN, current),
                kind: "example",
                blocks: current,
            });
            current = null;
        };

        for (const b of section.blocks) {
            if (b.kind === "heading" && CONDITION_HEADING.test(b.text)) {
                flushExample();
                current = [];
                continue;
            }
            if (current === null) {
                // Prose between the "Упражнения" heading and the first problem.
                continue;
            }
            // "Решение" and "Проверка" stay, as headings, so the page says
            // which half of the problem you are looking at.
            if (b.kind === "heading" && !WITHIN_EXAMPLE.test(b.text)) continue;
            current.push(b);
        }
        flushExample();
    }

    return nodes.flatMap(splitOversized);
}

/**
 * Cut a node that is too long into "… (1/3)" parts.
 *
 * Breaks are taken before a heading where there is one and before a paragraph
 * otherwise, never between a list item and the item above it or between a
 * figure and the sentence that introduces it — a part boundary is a place you
 * arrive at, so it should be the start of something.
 */
function splitOversized(node: EncNode): EncNode[] {
    if (weight(node.blocks) <= MAX_NODE_WEIGHT) return [node];

    const parts: Block[][] = [];
    let current: Block[] = [];
    let carried = 0;

    for (const b of node.blocks) {
        const breakable = b.kind === "heading" || b.kind === "para";
        if (carried >= MAX_NODE_WEIGHT && breakable && current.length) {
            parts.push(current);
            current = [];
            carried = 0;
        }
        current.push(b);
        carried += weigh(b);
    }
    if (current.length) parts.push(current);
    if (parts.length < 2) return [node];

    return parts.map((blocks, i) => ({
        ...node,
        id: `${node.id}p${i + 1}`,
        title: `${node.title} (${i + 1}/${parts.length})`,
        label: shorten(`${node.label} (${i + 1}/${parts.length})`),
        blocks,
    }));
}
