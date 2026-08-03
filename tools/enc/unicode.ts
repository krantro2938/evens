// Can this formula be a line of text instead of a picture?
//
// A text page costs ~400 bytes and paints in one write. A tile page costs
// ~10 KB and four BLE image pushes. Over a hundred nodes that difference is the
// whole storage budget, so every formula gets asked the question — and only the
// ones that genuinely cannot answer it become images.
//
// Two independent tests, and a formula has to pass both:
//
//   1. Does it CONVERT? texToReadable (the client's own TeX->Unicode, reused
//      here so the packer's decision and the panel's rendering can never
//      disagree) leaves anything it doesn't understand alone. A backslash or a
//      brace in the output means it gave up, and shipping that would print
//      "\overrightarrow{AB}" on the glasses.
//   2. Does the FONT HAVE IT? @evenrealities/pretext exposes the advance widths
//      EvenHub's own font stack uses, and a codepoint with no glyph returns 0.
//      That is not a heuristic — it is the same table the firmware consults,
//      and it is how the missing "▸" in menu.ts would have been caught.

import { getAdvW, measureTextWrap } from "@evenrealities/pretext";
import { texToReadable } from "../../test/src/render/textMath";

/**
 * Font-selection macros carry no meaning the panel can show.
 *
 * There is one font on the glasses, so \mathbf{C} and C look identical — but
 * texToReadable doesn't parse macro arguments and leaves the whole thing alone,
 * which sends a formula that would have read perfectly well to the renderer
 * instead. \operatorname is the expensive one: this course writes arctg, tg and
 * ctg constantly, and every one of them would have become an image.
 */
const PLAIN_MACROS = /\\(operatorname|mathbf|mathrm|mathit|mathbb|text|mathcal)\{([^{}]*)\}/g;

export const texToUnicode = (tex: string): string =>
    texToReadable(tex.replace(PLAIN_MACROS, "$2"))
        // "(a)/(b)" is what an unwrapped \frac looks like, and the brackets
        // earn their place only when either side is more than a single term.
        .replace(/\(([^()\s]{1,3})\)\/\(([^()\s]{1,3})\)/g, "$1/$2");

/** Codepoints the panel font cannot draw, deduplicated. */
export function missingGlyphs(text: string): string[] {
    const missing = new Set<string>();
    for (const ch of text) {
        // Newlines and the space are layout, not glyphs.
        if (ch === "\n" || ch === " ") continue;
        if (getAdvW(ch.codePointAt(0)!) === 0) missing.add(ch);
    }
    return [...missing];
}

/**
 * Whether a TeX string reads acceptably as one line of panel text.
 *
 * The length ceiling is doing real work. texToReadable turns \frac{a}{b} into
 * "(a)/(b)", which is honest for "1/2" and unreadable for a ratio of two
 * polynomials — by the time a formula is this long it has structure, and
 * structure is what the renderer is for.
 */
const TEX_TEXT_MAX = 46;

export function texIsTextSafe(tex: string): boolean {
    if (tex.length > TEX_TEXT_MAX) return false;
    // Environments are two-dimensional by definition — matrices, aligned
    // systems, cases. There is no line of text that is one of those.
    if (/\\begin\{|\\\\|\\int|\\sum|\\prod|\\iint|\\oint|\\lim/.test(tex)) return false;

    const out = texToUnicode(tex);
    if (/[\\{}]/.test(out)) return false;
    // A nested fraction comes back as "((a)/(b))/(c)" — parseable, but not by a
    // person glancing at a HUD.
    if ((out.match(/\//g) ?? []).length > 1) return false;
    return missingGlyphs(out).length === 0;
}

// ── page fitting ────────────────────────────────────────────────────────────

/**
 * The text container's inner box.
 *
 * BODY_W/PAGE_H minus the container padding on each side, which is what
 * measureTextWrap wants — it measures text, not boxes. Nine lines of the host's
 * 27px line height fit in 252px and a tenth does not; the budget stops at eight
 * because content taller than its container makes the host attach a SCROLLER,
 * and that scroller then eats the swipes that turn the page (the same failure
 * documented at settings.ts:101 and constants.ts DOC_PAGER_H).
 */
export const TEXT_WIDTH = 556;
export const TEXT_MAX_LINES = 8;

/** How many wrapped lines a paragraph takes on the panel. */
export const lineCount = (text: string): number =>
    text
        .split("\n")
        .reduce((n, line) => n + (line.trim() ? measureTextWrap(line, TEXT_WIDTH).lineCount : 1), 0);
