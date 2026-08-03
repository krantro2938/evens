// Blocks -> the markdown the renderer eats, and blocks -> the plain text the
// panel writes directly.
//
// Two outputs from one source because a page is one or the other (see
// paginate.ts): a formula-heavy page is rendered to tiles by Chromium, a prose
// page is written straight into a text container and never becomes an image at
// all.

import type { Block } from "./convert";
import { figureDataUri, figureName } from "./images";
import { texToUnicode } from "./unicode";

/** One block as markdown. Consecutive list items are stitched by `toMarkdown`. */
function blockMd(b: Block, figures: Map<string, string>): string {
    switch (b.kind) {
        case "heading":
            return `${"#".repeat(Math.min(6, b.level))} ${b.text}`;
        case "para":
            return b.text;
        case "item":
            return `${b.marker} ${b.text}`;
        case "math":
            return `$$${b.tex}$$`;
        case "table":
            // A grid of cells is maths here — a sign pattern, a Gram matrix —
            // and it arrived as TeX cells, so it is set as one rather than as a
            // markdown table nothing on a 576px panel could read.
            return `$$\\begin{matrix} ${b.rows
                .map((r) => r.map((c) => c.trim() || "\\,").join(" & "))
                .join(" \\\\ ")} \\end{matrix}$$`;
        case "figure": {
            const uri = figures.get(b.figure.src);
            if (!uri) return "";
            // Raw HTML rather than "![](…)": `viz-block` is the class the
            // paginator treats as indivisible (see keepTogether in
            // server/render/tiles.ts), so this is what stops a page boundary
            // landing between a figure and its caption.
            const caption = b.figure.caption
                ? `<div class="viz-caption">${escapeHtml(b.figure.caption)}</div>`
                : "";
            return `<div class="viz-block"><img src="${uri}" style="max-width:100%">${caption}</div>`;
        }
    }
}

const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Blocks -> markdown, with the figures inlined as data URIs.
 *
 * Data URIs rather than file paths because the renderer runs `setContent` on a
 * page with no base URL and no server behind it — a relative src resolves to
 * nothing and screenshots as a broken-image glyph.
 */
export async function toMarkdown(blocks: Block[], articleNo: number): Promise<string> {
    const figures = new Map<string, string>();
    for (const b of blocks) {
        if (b.kind !== "figure" || figures.has(b.figure.src)) continue;
        const name = figureName(articleNo, b.figure.src);
        try {
            figures.set(b.figure.src, await figureDataUri(name));
        } catch {
            // Packed with no figure; blockMd drops it.
        }
    }

    // Separators matter: two adjacent list items joined by ONE newline are a
    // single <ul>, joined by two they are two lists, and marked puts a margin
    // between those — which on a 252px page is a wasted line per bullet.
    let text = "";
    blocks.forEach((b, i) => {
        const md = blockMd(b, figures);
        if (!md) return;
        const prev = blocks[i - 1];
        const tight = b.kind === "item" && prev?.kind === "item";
        text += (text ? (tight ? "\n" : "\n\n") : "") + md;
    });
    return text;
}

// ── the text-mode half ──────────────────────────────────────────────────────

/**
 * Blocks -> lines for a native text container.
 *
 * No markdown syntax survives: the panel has one font and no styling, so bold
 * markers would print as asterisks. Formulas become Unicode (see unicode.ts),
 * and a block whose formulas cannot survive that never reaches here — the
 * paginator sends it to the renderer instead.
 */
export function toPlainText(blocks: Block[]): string {
    const lines: string[] = [];
    for (const b of blocks) {
        switch (b.kind) {
            case "heading":
                lines.push(strip(b.text).toUpperCase());
                break;
            case "para":
                lines.push(strip(b.text));
                break;
            case "item":
                lines.push(`${b.marker === "-" ? "-" : b.marker} ${strip(b.text)}`);
                break;
            case "math":
                lines.push(texToUnicode(b.tex));
                break;
            default:
                break;
        }
    }
    return lines.join("\n");
}

/** Markdown emphasis and escapes removed, inline maths turned into Unicode. */
function strip(text: string): string {
    return text
        .replace(/\$([^$]+)\$/g, (_, tex) => texToUnicode(tex))
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/\\([*_`[\]])/g, "$1")
        .replace(/\s+([.,;:])/g, "$1")
        .replace(/[ \t]+/g, " ")
        .trim();
}
