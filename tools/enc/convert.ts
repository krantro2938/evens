// The normalized DOM tree -> markdown blocks.
//
// Two walkers, because the source has two languages in it. `mathSource` runs
// inside anything the author marked as a formula and produces TeX; `inline`
// runs everywhere else and produces markdown. They meet at
// <span class="math">, which is the site's only marker for "this is maths".
//
// Blocks rather than a markdown string, because the paginator downstream needs
// to weigh each piece separately — a paragraph might fit on a text page while
// the formula after it has to be rendered (see paginate.ts).

import type { Node } from "./dom";
import { splitCyrillic, toTex } from "./mathize";

export interface Figure {
    /** Path relative to the article, as written in the source ("2.jpg"). */
    src: string;
    caption: string;
}

export type Block =
    | { kind: "heading"; level: number; text: string }
    | { kind: "para"; text: string }
    | { kind: "math"; tex: string }
    /**
     * ONE list item, not a list.
     *
     * The source nests display formulas, figures and sub-lists inside <li>,
     * and a Block that owned an array of item strings had nowhere to put them
     * — they came out hoisted above the list they belonged to, so every worked
     * example read as its own answer followed by its own question. An item per
     * block keeps document order, and the markdown assembler stitches
     * consecutive ones back into a real list.
     */
    | { kind: "item"; marker: string; text: string }
    | { kind: "figure"; figure: Figure }
    | { kind: "table"; rows: string[][] };

const isEl = (n: Node): n is Extract<Node, { t: "el" }> => n.t === "el";
const cls = (n: Node, name: string) => isEl(n) && n.cls.split(/\s+/).includes(name);

/** Collapse the source's generous whitespace, keeping single spaces. */
const squash = (s: string) => s.replace(/[\s ]+/g, " ");

// ── maths ───────────────────────────────────────────────────────────────────

/**
 * "a<sub>1</sub><sub>1</sub>" is how the author writes a double subscript, and
 * "a_{1}_{1}" is a TeX error. Merging adjacent scripts of the same kind is the
 * only reading that isn't one.
 */
function mergeScripts(tex: string): string {
    let out = tex;
    for (const op of ["_", "^"]) {
        const re = new RegExp(`\\${op}\\{([^{}]*)\\}\\${op}\\{([^{}]*)\\}`, "g");
        let prev: string;
        do {
            prev = out;
            out = out.replace(re, `${op}{$1$2}`);
        } while (out !== prev);
    }
    return out;
}

/** The rows of a table as arrays of TeX cells. */
function cells(table: Node): string[][] {
    if (!isEl(table)) return [];
    const rows: string[][] = [];
    const visit = (n: Node) => {
        if (!isEl(n)) return;
        if (n.tag === "tr") {
            rows.push(n.kids.filter((k) => isEl(k) && (k.tag === "td" || k.tag === "th")).map(mathSource));
            return;
        }
        n.kids.forEach(visit);
    };
    table.kids.forEach(visit);
    return rows;
}

/** Ellipsis cells are written ".&nbsp;&nbsp;.&nbsp;&nbsp;." throughout. */
const ELLIPSIS = /^\s*\.\s*\.\s*\.\s*$/;

function matrixTex(table: Node, env: "pmatrix" | "vmatrix"): string {
    const rows = cells(table).filter((r) => r.length);
    if (!rows.length) return "";
    const body = rows
        .map((r) => r.map((c) => (ELLIPSIS.test(c) ? "\\cdots" : c.trim() || "\\,")).join(" & "))
        .join(" \\\\ ");
    return `\\begin{${env}} ${body} \\end{${env}}`;
}

function fractionTex(table: Node): string {
    // Three rows: numerator, the "—" rule, denominator. The author also leaves
    // EMPTY fraction tables around purely to reserve vertical space; those
    // arrive here with no rows and must vanish rather than become \frac{}{}.
    const rows = cells(table).map((r) => r.join(" ").trim());
    const parts = rows.filter((r) => r !== "" && !/^[—–-]+$/.test(r));
    if (parts.length === 0) return "";
    if (parts.length === 1) return parts[0];
    return `\\frac{${parts[0]}}{${parts.slice(1).join(" ")}}`;
}

/** Whether a table appears anywhere below this node. */
function containsTable(node: Node): boolean {
    if (!isEl(node)) return false;
    return node.kids.some((k) => (isEl(k) && k.tag === "table") || containsTable(k));
}

/** Anything inside a formula, as TeX-ready source (symbols still Unicode). */
function mathSource(node: Node): string {
    if (node.t === "text") return squash(node.v);
    if (node.tag === "br") return " \\\\ ";
    if (node.tag === "img") return "";

    if (node.tag === "table") {
        if (cls(node, "fraction")) return fractionTex(node);
        if (cls(node, "matrix")) return matrixTex(node, "pmatrix");
        if (cls(node, "deter")) return matrixTex(node, "vmatrix");
        return matrixTex(node, "pmatrix");
    }

    const inner = node.kids.map(mathSource).join("");

    // Bold inside a formula is how this source writes a set or a vector — the
    // complex numbers are "<b>C</b>", a basis vector "<b>e</b>". Italic is the
    // default for a maths variable, so only bold carries meaning here.
    if (node.tag === "b" || node.tag === "strong") {
        return inner.trim() ? `\\mathbf{${inner.trim()}}` : "";
    }

    if (node.tag === "sup" || node.tag === "sub") {
        // <sup> is also used as a pure layout hack — the author wraps a
        // fraction, or a stacked integral, in nested <sup> tags to raise it
        // inside a bracket. A superscripted fraction is never what a formula
        // means here, and "^{\int_1^\infty} f dx" is not even parseable: the
        // superscript has nothing to attach to and MathJax rejects the lot.
        //
        // Searched to any depth, because the tag the table sits inside is
        // sometimes another sup and sometimes a span.
        if (containsTable(node)) return inner;
        const body = inner.trim();
        if (!body) return "";
        return `${node.tag === "sup" ? "^" : "_"}{${body}}`;
    }

    return inner;
}

/** A whole formula span -> TeX, with the scripts merged. */
const spanTex = (node: Node): string => mergeScripts(mathSource(node)).trim();

// ── prose ───────────────────────────────────────────────────────────────────

/** Characters marked would read as syntax if the article happens to use them. */
const escapeMd = (s: string) => s.replace(/([*_`[\]])/g, "\\$1");

/**
 * Wrap a formula for markdown. `\\` only means a line break inside an
 * alignment environment; outside one MathJax reports an error and the formula
 * is replaced by red source text.
 */
function inlineMath(tex: string): string {
    if (!tex) return "";
    const body = tex.includes("\\\\") ? `\\begin{aligned} ${tex} \\end{aligned}` : tex;
    return `$${body}$`;
}

function displayMath(tex: string): string {
    if (!tex) return "";
    return tex.includes("\\\\") ? `\\begin{aligned} ${tex} \\end{aligned}` : tex;
}

/**
 * Prose -> markdown. Formula spans come back as $…$, with any Russian inside
 * them lifted out into the surrounding sentence (see mathize.splitCyrillic).
 */
function inline(node: Node): string {
    if (node.t === "text") return escapeMd(squash(node.v));
    if (node.tag === "br") return " ";
    if (node.tag === "img") return "";

    if (node.tag === "table") {
        // A bare formula table in running prose — a fraction mid-sentence.
        return inlineMath(mergeScripts(mathSource(node)).trim());
    }

    if (cls(node, "math")) {
        return splitCyrillic(mathSource(node))
            .map((p) => (p.kind === "math" ? inlineMath(mergeScripts(p.value)) : escapeMd(p.value)))
            .join(" ");
    }

    if (node.tag === "sup" || node.tag === "sub") {
        return inlineMath(spanTex(node));
    }

    const inner = node.kids.map(inline).join("");
    if (node.tag === "b" || node.tag === "strong") return inner.trim() ? `**${inner.trim()}**` : "";
    if (node.tag === "i" || node.tag === "em") return inner.trim() ? `*${inner.trim()}*` : "";
    return inner;
}

// ── blocks ──────────────────────────────────────────────────────────────────

const FIGURE_CAPTION = /^\s*Рису?нок\s*\d+\s*[—–-]?\s*/i;

function figureOf(table: Node): Figure | null {
    if (!isEl(table)) return null;
    let src = "";
    const captionParts: string[] = [];
    const visit = (n: Node) => {
        if (n.t === "text") {
            captionParts.push(squash(n.v));
            return;
        }
        if (n.tag === "img") {
            src ||= n.src ?? "";
            return;
        }
        n.kids.forEach(visit);
    };
    table.kids.forEach(visit);
    if (!src) return null;
    const caption = captionParts.join("").replace(/\s+/g, " ").trim();
    return { src, caption: caption.replace(FIGURE_CAPTION, "").trim() || caption };
}

class Builder {
    readonly blocks: Block[] = [];
    private buffer = "";
    /** Marker waiting to be attached to the next paragraph produced — set on
     *  entering an <li>, so the item's own text becomes the bullet and
     *  everything after it stays a plain block in the same position. */
    private marker: string | null = null;

    /** End the paragraph being accumulated, if it has anything in it. */
    flush(): void {
        const text = this.buffer.replace(/\s+/g, " ").trim();
        this.buffer = "";
        // A paragraph that is nothing but punctuation is what's left when a
        // formula was lifted out of it; it reads as a stray ";" on the panel.
        if (!text || !/[\p{L}\p{N}$]/u.test(text)) return;
        if (this.marker !== null) {
            this.blocks.push({ kind: "item", marker: this.marker, text });
            this.marker = null;
            return;
        }
        this.blocks.push({ kind: "para", text });
    }

    write(text: string): void {
        this.buffer += text;
    }

    push(block: Block): void {
        this.flush();
        // An item whose text never arrived (an <li> that opens with a figure)
        // must not label whatever block comes next.
        this.marker = null;
        this.blocks.push(block);
    }

    /** The next paragraph is a list item. */
    bullet(marker: string): void {
        this.flush();
        this.marker = marker;
    }

    endItem(): void {
        this.flush();
        this.marker = null;
    }
}

function walk(nodes: readonly Node[], out: Builder): void {
    for (const node of nodes) {
        if (node.t === "text") {
            out.write(escapeMd(squash(node.v)));
            continue;
        }

        switch (node.tag) {
            case "h1":
            case "h2":
            case "h3":
            case "h4": {
                const text = node.kids.map(inline).join("").replace(/\s+/g, " ").trim();
                if (text) out.push({ kind: "heading", level: Number(node.tag[1]), text });
                break;
            }

            case "br":
                // A line break in this source separates two formulas or two
                // clauses that were meant to sit on their own lines. Treating
                // it as a paragraph break is what makes them paginate.
                out.flush();
                break;

            case "table": {
                if (cls(node, "img")) {
                    const figure = figureOf(node);
                    if (figure) out.push({ kind: "figure", figure });
                    break;
                }
                if (cls(node, "fraction") || cls(node, "matrix") || cls(node, "deter")) {
                    out.write(inline(node));
                    break;
                }
                const rows = cells(node).filter((r) => r.length);
                if (rows.length) out.push({ kind: "table", rows });
                break;
            }

            case "ul":
            case "ol": {
                out.flush();
                let n = 0;
                for (const li of node.kids) {
                    if (!isEl(li) || li.tag !== "li") continue;
                    n++;
                    out.bullet(node.tag === "ol" ? `${n}.` : "-");
                    walk(li.kids, out);
                    out.endItem();
                }
                break;
            }

            case "p":
            case "div":
            case "li":
            case "section":
                out.flush();
                walk(node.kids, out);
                out.flush();
                break;

            case "span":
                if (cls(node, "center") && cls(node, "math")) {
                    // A centred formula is a display formula — the only signal
                    // the source gives, and the reason a formula gets a line of
                    // its own instead of being crushed into a sentence.
                    const pieces = splitCyrillic(mathSource(node));
                    for (const p of pieces) {
                        if (p.kind === "math") {
                            const tex = displayMath(mergeScripts(p.value).trim());
                            if (tex) out.push({ kind: "math", tex });
                        } else {
                            out.write(` ${escapeMd(p.value)} `);
                        }
                    }
                    out.flush();
                } else {
                    out.write(inline(node));
                }
                break;

            default:
                out.write(inline(node));
        }
    }
}

export interface Article {
    no: number;
    title: string;
    blocks: Block[];
}

export function convertArticle(no: number, tree: Node[]): Article {
    const out = new Builder();
    walk(tree, out);
    out.flush();

    const blocks = out.blocks;
    // The <h1> is the article title, and the node tree carries it as metadata
    // instead — repeating it as the first line of every page wastes the one
    // heading row a 252px page has.
    const titleAt = blocks.findIndex((b) => b.kind === "heading" && b.level === 1);
    const title = titleAt >= 0 ? (blocks[titleAt] as { text: string }).text : `maga${no}`;
    if (titleAt >= 0) blocks.splice(titleAt, 1);

    // "Дата написания статьи: …" is the site's own byline, not content.
    const dated = blocks.findIndex((b) => b.kind === "para" && /Дата написания/i.test(b.text));
    if (dated >= 0) blocks.splice(dated, 1);

    return { no, title, blocks };
}
