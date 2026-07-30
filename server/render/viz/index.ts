// A ```viz fence in a document -> inline SVG.
//
// WHY A FENCE, AND WHY A SPEC
//
// Markdown is this system's only transport. The same text crosses the reader's
// `/assignment.md`, an SSE payload, a SQLite column, the solver's JSON submit and
// finally this renderer — so a visualisation has to be plain text embedded in
// markdown, exactly as `$…$` maths already is. A fenced block is the one form
// that survives every one of those hops untouched.
//
// The block holds a *spec*, not SVG. A model asked for SVG has to make a hundred
// decisions this file already knows the answers to — stroke width, label size,
// which greys survive a 16-colour palette, how wide the panel is — and gets them
// wrong in a way nobody can validate. A spec is ~30 tokens instead of ~600, is
// checked before anything is drawn, and when it fails the reader sees the caption
// instead of a broken page.
//
//   ```viz
//   {"kind":"plot","x":[-3,3],"fns":["x^2-3"],"points":[{"at":[1.73,0],"label":"√3"}],
//    "caption":"y = x² − 3"}
//   ```

import { esc, mathText } from "./canvas";
import { renderBars, renderFigure, renderNumberLine, renderPlot, VizError, type Spec } from "./kinds";

export { VIZ_W, VIZ_H_MAX } from "./canvas";

/**
 * Fence languages that mean "this is a visualisation". The plain kind names are
 * accepted as languages too (```plot), because that is what a model writes when
 * it has seen one example of each.
 */
export const VIZ_LANGS = new Set([
    "viz",
    "plot",
    "graph",
    "figure",
    "geometry",
    "diagram",
    "bars",
    "bar",
    "barchart",
    "vectors",
    "vector",
    "number-line",
    "numberline",
    "number_line",
]);

const KINDS: Record<string, (spec: Spec) => string> = {
    plot: renderPlot,
    graph: renderPlot,
    vectors: renderPlot,
    vector: renderPlot,
    figure: renderFigure,
    geometry: renderFigure,
    diagram: renderFigure,
    bars: renderBars,
    bar: renderBars,
    barchart: renderBars,
    "number-line": renderNumberLine,
    numberline: renderNumberLine,
    number_line: renderNumberLine,
};

/**
 * JSON, but tolerant of what a model actually emits: `//` and `/* *\/` comments,
 * and a trailing comma before a closing brace or bracket. String contents are
 * left strictly alone, so a caption containing "//" is not mangled.
 *
 * This is not an attempt at a general relaxed-JSON parser — it fixes the two
 * mistakes that otherwise turn a whole worked solution into an error box.
 */
export function looseJson(src: string): unknown {
    let out = "";
    let inString = false;
    for (let i = 0; i < src.length; i++) {
        const c = src[i]!;
        if (inString) {
            out += c;
            if (c === "\\") {
                out += src[i + 1] ?? "";
                i++;
            } else if (c === '"') {
                inString = false;
            }
            continue;
        }
        if (c === '"') {
            inString = true;
            out += c;
            continue;
        }
        if (c === "/" && src[i + 1] === "/") {
            while (i < src.length && src[i] !== "\n") i++;
            out += "\n";
            continue;
        }
        if (c === "/" && src[i + 1] === "*") {
            const end = src.indexOf("*/", i + 2);
            i = end < 0 ? src.length : end + 1;
            continue;
        }
        if (c === ",") {
            // Look ahead past whitespace: a comma before } or ] is trailing.
            let j = i + 1;
            while (j < src.length && /\s/.test(src[j]!)) j++;
            if (src[j] === "}" || src[j] === "]") continue;
        }
        out += c;
    }
    return JSON.parse(out.trim());
}

/** Cap per document: a page of nothing but figures is a render that times out. */
export const MAX_VIZ_PER_DOC = Number(process.env.VIZ_MAX_PER_DOC ?? 24);

export interface VizResult {
    html: string;
    /** False when the block fell back to its caption, for the log line. */
    drawn: boolean;
}

/**
 * Render one fence body. Never throws: a document is read by someone holding a
 * pen, and a bad figure must cost them the figure, not the solution around it.
 *
 * `lang` is the fence's info string, used as the kind when the spec omits one.
 */
export function renderVizBlock(body: string, lang = "viz"): VizResult {
    let spec: Spec;
    try {
        const parsed = looseJson(body);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new VizError("the block is not a JSON object");
        }
        spec = parsed as Spec;
    } catch (err) {
        return failure("", `${(err as Error).message}`, body);
    }

    const named = typeof spec.kind === "string" ? spec.kind.trim().toLowerCase() : "";
    const kind = named || (lang === "viz" ? "" : lang);
    const caption = typeof spec.caption === "string" ? spec.caption : "";

    const draw = KINDS[kind];
    if (!draw) {
        return failure(
            caption,
            kind ? `unknown kind "${kind}"` : "no kind given",
            body,
        );
    }

    try {
        const svg = draw(spec);
        return {
            drawn: true,
            html:
                `<div class="viz-block">${svg}` +
                (caption ? `<div class="viz-caption">${esc(mathText(caption))}</div>` : "") +
                `</div>`,
        };
    } catch (err) {
        if (err instanceof VizError) return failure(caption, err.message, body);
        // A bug in a renderer, not bad input — still not a reason to lose the page.
        console.error("[viz] renderer threw:", err);
        return failure(caption, "could not be drawn", body);
    }
}

/**
 * The fallback. A caption is the figure in words, so showing it is a real
 * degradation rather than an apology — and it is why every kind asks for one.
 */
function failure(caption: string, reason: string, body: string): VizResult {
    console.warn(`[viz] ${reason}: ${body.replace(/\s+/g, " ").slice(0, 160)}`);
    const text = caption
        ? esc(mathText(caption))
        : `figure could not be drawn — ${esc(reason)}`;
    return { drawn: false, html: `<div class="viz-error">${text}</div>` };
}
