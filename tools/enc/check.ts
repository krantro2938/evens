// What the conversion got wrong, said out loud.
//
// Five hundred formulas converted by rules will not be perfect, and the failure
// mode that matters is the silent one: a fraction that came out as a stray "—",
// an entity that never decoded, a formula MathJax refused that renders as red
// source text on the glasses. None of those crash the build, and none of them
// are visible in a 3 MB pack.
//
// So every block is checked on the way past, and the build prints what it
// found. The list is meant to be read and acted on, not to gate the build —
// a pack with three odd formulas in it is worth having, and worth knowing about.

import type { Block } from "./convert";
import { texToSvg } from "../../server/render/math";
import { getAdvW } from "@evenrealities/pretext";
import { lineCount, TEXT_MAX_LINES } from "./unicode";

export interface Finding {
    where: string;
    what: string;
    sample?: string;
}

/** Markup that should have been converted and wasn't. */
const RESIDUE: { re: RegExp; what: string }[] = [
    { re: /<\/?(table|tr|td|span|sup|sub|div|img)\b/i, what: "unconverted HTML" },
    { re: /&[a-z]+;|&#\d+;/i, what: "undecoded entity" },
    { re: /\\sqrt\{\}|\\frac\{\}|\\operatorname\{\}/, what: "empty macro argument" },
    { re: /[Ѐ-ӿ]/u, what: "Cyrillic inside maths" },
];

function texOf(b: Block): string[] {
    if (b.kind === "math") return [b.tex];
    if ("text" in b) return [...b.text.matchAll(/\$([^$]+)\$/g)].map((m) => m[1]);
    return [];
}

export function checkBlocks(where: string, blocks: Block[]): Finding[] {
    const found: Finding[] = [];
    const seen = new Set<string>();

    const note = (what: string, sample: string) => {
        // One line per kind of problem per source, not one per occurrence: the
        // useful output is "maga7 has undecoded entities", and forty copies of
        // that buries the one finding underneath it.
        const key = `${where}|${what}`;
        if (seen.has(key)) return;
        seen.add(key);
        found.push({ where, what, sample: sample.slice(0, 120) });
    };

    for (const b of blocks) {
        if ("text" in b) {
            for (const rule of RESIDUE.slice(0, 2)) {
                if (rule.re.test(b.text)) note(rule.what, b.text);
            }
        }
        for (const tex of texOf(b)) {
            for (const rule of RESIDUE) {
                if (rule.re.test(tex)) note(rule.what, tex);
            }
            // The real test. Everything above is a proxy for this one.
            const svg = texToSvg(tex, true);
            if (/merror|data-mjx-error|math-error/.test(svg)) note("MathJax rejected", tex);
        }
    }
    return found;
}

/**
 * The finished pages, checked against the panel that has to show them.
 *
 * This is a different question from "did the maths parse", and it is the one
 * that caught the bug worth having a check for: a placeholder the authored-
 * markdown parser leaves behind when it fails to match its own token was
 * shipping as a literal control character in the middle of 514 pages. Every
 * formula parsed, no markup was left over, and the pages were wrong anyway.
 *
 * Two things a text page must satisfy, both measurable:
 *
 *   - It fits. Nine 27px rows fit the reader's body container and a tenth does
 *     not, and content taller than its container makes the host attach a
 *     scroller that then swallows the swipes that turn the page. The budget is
 *     eight, for slack.
 *   - Every character has a glyph. getAdvW returns 0 for a codepoint the panel
 *     font cannot draw — the same table that would have caught the missing "▸"
 *     in menu.ts — and a glyph that isn't there fails SILENTLY, as a gap.
 */
export function auditPages(
    where: string,
    pages: readonly { kind: string; text?: string }[],
): Finding[] {
    const found: Finding[] = [];
    const missing = new Map<string, string>();
    let over = 0;
    let worst = "";

    for (const page of pages) {
        if (page.kind !== "text" || !page.text) continue;

        const lines = lineCount(page.text);
        if (lines > TEXT_MAX_LINES) {
            over++;
            if (!worst) worst = `${lines} lines: ${page.text.slice(0, 80)}`;
        }
        for (const ch of page.text) {
            if (ch === "\n" || ch === " " || missing.has(ch)) continue;
            if (getAdvW(ch.codePointAt(0)!) === 0) missing.set(ch, page.text.slice(0, 80));
        }
    }

    if (over) found.push({ where, what: `${over} text page(s) over the line budget`, sample: worst });
    for (const [ch, sample] of missing) {
        found.push({
            where,
            what: `no glyph for U+${ch.codePointAt(0)!.toString(16).padStart(4, "0").toUpperCase()}`,
            sample,
        });
    }
    return found;
}

export function report(findings: Finding[]): void {
    if (!findings.length) {
        console.log("\nCheck: clean — every formula parsed and no markup left over.");
        return;
    }
    console.log(`\nCheck: ${findings.length} finding(s)`);
    for (const f of findings) {
        console.log(`  ${f.where.padEnd(22)} ${f.what}`);
        if (f.sample) console.log(`  ${" ".repeat(22)} ${f.sample}`);
    }
}
