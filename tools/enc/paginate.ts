// Blocks -> pages, each one either text or an image.
//
// This is where "a combination of text and image" is actually decided. The
// panel can do both and they cost wildly different amounts:
//
//   text page   ~400 bytes, one container write, appears instantly
//   tile page   ~10 KB, four image pushes over BLE, ~1s
//
// So the rule is: text unless the content genuinely needs shape. A sentence, a
// definition, "i² = -1" — text. A matrix, an integral with limits, a figure, a
// ratio of two polynomials — an image, because those ARE their layout.
//
// The decision is per RUN of blocks rather than per block, because alternating
// between the two on every paragraph would produce dozens of two-line pages and
// a page turn between a formula and the sentence explaining it.

import type { Block } from "./convert";
import { toMarkdown, toPlainText } from "./markdown";
import { TEXT_MAX_LINES, lineCount, texIsTextSafe } from "./unicode";
import { renderChunk } from "./render";

export type Page =
    | { kind: "text"; text: string }
    /** Four base64 PNGs, row-major, exactly as the client pushes them. */
    | { kind: "tiles"; tiles: string[] };

/** Whether a block can be written as panel text without losing anything. */
export function isTextSafe(b: Block): boolean {
    switch (b.kind) {
        case "figure":
        case "table":
            return false;
        case "math":
            // A DISPLAY formula is display because it has structure worth
            // showing; the bar is deliberately higher than for inline maths.
            return texIsTextSafe(b.tex) && b.tex.length <= 24;
        case "heading":
            return true;
        case "para":
        case "item": {
            const maths = [...b.text.matchAll(/\$([^$]+)\$/g)].map((m) => m[1]);
            return maths.every(texIsTextSafe);
        }
    }
}

/**
 * How much text is worth pulling onto a rendered page rather than giving a page
 * of its own.
 *
 * This is the difference between a readable document and a slideshow. Theory
 * prose alternates constantly — a sentence, the formula it introduces, a
 * sentence about the formula — and treating every switch as a page boundary
 * gives you a page holding one formula on a black field, then a page holding
 * two lines of text, for eleven pages per section. Rendering the short text
 * WITH the formula puts them where the article had them: together, one swipe.
 *
 * The ceiling is a third of a page. Past that the text deserves its own page
 * and rendering it would only make it cost twenty times as much to send.
 */
const ABSORB_MAX_BLOCKS = 3;
const ABSORB_MAX_LINES = 3;

interface Run {
    text: boolean;
    blocks: Block[];
}

function runs(blocks: Block[]): Run[] {
    const out: Run[] = [];
    for (const b of blocks) {
        const text = isTextSafe(b);
        const last = out[out.length - 1];
        if (last && last.text === text) last.blocks.push(b);
        else out.push({ text, blocks: [b] });
    }

    // Absorb short text runs into a neighbouring rendered run.
    //
    // ONE DIRECTION ONLY: text joins a rendered run, never the reverse. The
    // renderer can express anything text can and the converse is false —
    // pulling a matrix onto a text page would print the literal characters
    // "\begin{pmatrix}", which is the exact failure isTextSafe exists to catch.
    const merged: Run[] = [];
    for (let i = 0; i < out.length; i++) {
        const run = out[i];
        const prev = merged[merged.length - 1];
        const next = out[i + 1];

        if (prev && prev.text === run.text) {
            prev.blocks.push(...run.blocks);
            continue;
        }

        const short =
            run.text &&
            run.blocks.length <= ABSORB_MAX_BLOCKS &&
            lineCount(toPlainText(run.blocks)) <= ABSORB_MAX_LINES;
        // Forward first: prose almost always introduces the formula after it,
        // so a lead-in reads better at the top of the rendered page than
        // orphaned at the bottom of the one before.
        if (short && next && !next.text) {
            next.blocks.unshift(...run.blocks);
            continue;
        }
        if (short && prev && !prev.text) {
            prev.blocks.push(...run.blocks);
            continue;
        }

        merged.push({ text: run.text, blocks: [...run.blocks] });
    }

    // A heading belongs with what it introduces, not with what it ends.
    for (let i = 0; i < merged.length - 1; i++) {
        const run = merged[i];
        const tail = run.blocks[run.blocks.length - 1];
        if (run.blocks.length > 1 && tail?.kind === "heading") {
            run.blocks.pop();
            merged[i + 1].blocks.unshift(tail);
        }
    }

    return merged.filter((r) => r.blocks.length > 0);
}

/**
 * Text blocks -> the groups that each become one page.
 *
 * Groups rather than finished pages, so the caller can still take the last one
 * back — see `paginate`.
 */
function textGroups(blocks: Block[]): Block[][] {
    const pages: Block[][] = [];
    let current: Block[] = [];
    let lines = 0;

    const flush = () => {
        if (!current.length) return;
        if (toPlainText(current).trim()) pages.push(current);
        current = [];
        lines = 0;
    };

    for (const b of blocks) {
        const rendered = toPlainText([b]);
        if (!rendered.trim()) continue;
        // +1 for the blank line this block gets under the previous one.
        const cost = lineCount(rendered) + (current.length ? 1 : 0);

        if (cost > TEXT_MAX_LINES) {
            // A single paragraph longer than a page. Split it on sentence
            // boundaries — mid-sentence would be a page turn in the middle of a
            // clause, and there is no scrollbar here to reassure anyone.
            flush();
            for (const chunk of splitLong(rendered)) pages.push([{ kind: "para", text: chunk }]);
            continue;
        }
        if (lines + cost > TEXT_MAX_LINES) flush();
        current.push(b);
        lines += cost;
    }
    flush();
    return pages;
}

const groupPage = (blocks: Block[]): Page => ({ kind: "text", text: toPlainText(blocks) });

function splitLong(text: string): string[] {
    const sentences = text.split(/(?<=[.;:!?])\s+/);
    const out: string[] = [];
    let buf = "";
    for (const s of sentences) {
        const candidate = buf ? `${buf} ${s}` : s;
        if (lineCount(candidate) > TEXT_MAX_LINES && buf) {
            out.push(buf);
            buf = s;
        } else {
            buf = candidate;
        }
    }
    if (buf.trim()) out.push(buf);
    // A single sentence that still doesn't fit is left whole and allowed to be
    // clipped rather than cut mid-word. It is rare, and one is better than two.
    return out;
}

/** Everything: a node's blocks become an ordered list of pages. */
export async function paginate(blocks: Block[], articleNo: number): Promise<Page[]> {
    const pages: Page[] = [];
    const list = runs(blocks);

    for (let i = 0; i < list.length; i++) {
        const run = list[i];
        const next = list[i + 1];

        if (run.text) {
            const groups = textGroups(run.blocks);
            // A text run ends wherever the line budget said, which is usually
            // mid-thought and often two lines into a page. When a rendered run
            // comes next, that stub is the sentence introducing its first
            // formula — so it goes onto the rendered page instead of costing a
            // swipe of its own. This is the common case: theory alternates
            // prose and formulas the whole way down.
            const tail = groups[groups.length - 1];
            if (next && !next.text && tail && lineCount(toPlainText(tail)) <= ABSORB_MAX_LINES) {
                groups.pop();
                next.blocks.unshift(...tail);
            }
            pages.push(...groups.map(groupPage));
            continue;
        }

        const md = await toMarkdown(run.blocks, articleNo);
        if (!md.trim()) continue;
        pages.push(...(await renderChunk(md)));
    }
    return pages;
}
