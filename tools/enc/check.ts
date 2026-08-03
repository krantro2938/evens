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
