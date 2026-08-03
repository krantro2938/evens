// TeX -> readable inline text, for the plain-text last-resort fallback
// (docPage.ts's showTextFallback). No image rendering and no LaTeX parser:
// unicodeit substitutes known symbols/super/subscripts one token at a time,
// but doesn't parse macro arguments, so \frac{a}{b} and \sqrt{a} pass through
// it untouched. This unwraps those two first — the only argument-taking
// macros the solver actually emits — then hands the rest to unicodeit.
//
// Deliberately single-line output: the target is a proportional-font native
// text panel that word-wraps flowing prose, not a monospace grid, so there is
// nowhere for a multi-line ASCII fraction to live without breaking the
// sentence it sits inside.

import { replace } from "unicodeit";

/** Index of the "}" matching the "{" at `open`, or -1 if unbalanced. */
function matchBrace(s: string, open: number): number {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
        if (s[i] === "{") depth++;
        else if (s[i] === "}" && --depth === 0) return i;
    }
    return -1;
}

/** \frac{a}{b} -> (a)/(b), \sqrt{a} -> √(a), recursively. */
function unwrapArgMacros(tex: string): string {
    let out = "";
    let i = 0;
    while (i < tex.length) {
        const isFrac = tex.startsWith("\\frac", i);
        const isSqrt = !isFrac && tex.startsWith("\\sqrt", i);
        if (!isFrac && !isSqrt) {
            out += tex[i];
            i++;
            continue;
        }

        let j = i + 5; // both "\frac" and "\sqrt" are 5 characters
        while (tex[j] === " ") j++;
        if (tex[j] !== "{") {
            out += tex[i];
            i++;
            continue;
        }
        const close1 = matchBrace(tex, j);
        if (close1 === -1) {
            out += tex[i];
            i++;
            continue;
        }
        const arg1 = unwrapArgMacros(tex.slice(j + 1, close1));

        if (isSqrt) {
            out += `√(${arg1})`;
            i = close1 + 1;
            continue;
        }

        let k = close1 + 1;
        while (tex[k] === " ") k++;
        if (tex[k] === "{") {
            const close2 = matchBrace(tex, k);
            if (close2 !== -1) {
                const arg2 = unwrapArgMacros(tex.slice(k + 1, close2));
                out += `(${arg1})/(${arg2})`;
                i = close2 + 1;
                continue;
            }
        }
        // Malformed \frac with only one argument — nothing sane to divide by.
        out += arg1;
        i = close1 + 1;
    }
    return out;
}

// Function-name macros: plain upright text in real LaTeX, not a symbol, so
// unicodeit doesn't map them — it leaves \sin untouched and, worse, matches
// \log as its unrelated symbol \l ("ł") followed by literal "og". Longest
// names first so "arcsin"/"sinh" aren't cut short by "sin" matching a prefix.
const OPERATOR_NAMES = [
    "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
    "sin", "cos", "tan", "log", "ln", "exp", "lim", "min", "max", "det", "gcd", "mod",
];
const OPERATOR_RE = new RegExp(`\\\\(${OPERATOR_NAMES.join("|")})(?![a-zA-Z])`, "g");

export function texToReadable(tex: string): string {
    try {
        const named = tex.replace(OPERATOR_RE, "$1");
        return replace(unwrapArgMacros(named)).trim();
    } catch {
        return tex;
    }
}
