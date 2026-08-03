// The site's formulas are HTML, not TeX. This turns what the DOM hands back
import { translit } from "./translit";
// into TeX that MathJax will actually render.
//
// The one rule that shapes everything here: MATHJAX HAS NO CYRILLIC. Its TeX
// fonts ship Latin, Greek and symbols, so a Russian word inside $…$ comes out
// as blank boxes — and this course writes Russian inside its formulas
// constantly ("x_макс", "S_полн", "при n → ∞"). So Cyrillic is never allowed
// into a math span: `splitCyrillic` pulls those runs back out into ordinary
// prose, where Chromium renders them with a real system font.
//
// Everything else is a symbol table and two argument-grabbing macros.

/** Unicode the browser decoded from entities, mapped to TeX. */
const SYMBOLS: Record<string, string> = {
    "π": "\\pi", "φ": "\\varphi", "ϕ": "\\phi", "α": "\\alpha", "β": "\\beta",
    "γ": "\\gamma", "δ": "\\delta", "ε": "\\varepsilon", "ζ": "\\zeta",
    "η": "\\eta", "θ": "\\theta", "ι": "\\iota", "κ": "\\kappa",
    "λ": "\\lambda", "μ": "\\mu", "ν": "\\nu", "ξ": "\\xi", "ρ": "\\rho",
    "σ": "\\sigma", "τ": "\\tau", "υ": "\\upsilon", "χ": "\\chi",
    "ψ": "\\psi", "ω": "\\omega",
    "Γ": "\\Gamma", "Δ": "\\Delta", "Θ": "\\Theta", "Λ": "\\Lambda",
    "Ξ": "\\Xi", "Π": "\\Pi", "Σ": "\\Sigma", "Φ": "\\Phi", "Ψ": "\\Psi",
    "Ω": "\\Omega",
    "∞": "\\infty", "±": "\\pm", "∓": "\\mp", "×": "\\times", "÷": "\\div",
    "·": "\\cdot", "≤": "\\le", "≥": "\\ge", "≠": "\\ne", "≈": "\\approx",
    "≡": "\\equiv", "∈": "\\in", "∉": "\\notin", "⊂": "\\subset",
    "∩": "\\cap", "∪": "\\cup", "∅": "\\varnothing", "∀": "\\forall",
    "∃": "\\exists", "∂": "\\partial", "∇": "\\nabla", "∫": "\\int",
    "∬": "\\iint", "∭": "\\iiint", "∮": "\\oint", "∑": "\\sum",
    "∏": "\\prod", "→": "\\to", "←": "\\leftarrow", "⇒": "\\Rightarrow",
    "⇔": "\\Leftrightarrow", "↔": "\\leftrightarrow", "∠": "\\angle",
    "∥": "\\parallel", "⊥": "\\perp", "°": "^\\circ", "′": "'", "″": "''",
    "…": "\\ldots", "⋯": "\\cdots", "⋮": "\\vdots", "⋱": "\\ddots",
    "∆": "\\Delta", "√": "\\sqrt", "∓": "\\mp", "ℝ": "\\mathbb{R}",
    "ℂ": "\\mathbb{C}", "ℕ": "\\mathbb{N}", "ℤ": "\\mathbb{Z}",
    "ℚ": "\\mathbb{Q}", "−": "-", "–": "-", "—": "-", " ": " ",
    " ": "\\,", "‖": "\\|",
};

/**
 * Function names, longest first so "arctg" is not eaten by "tg".
 *
 * Russian maths writes tg/ctg/arctg/sh/ch/th where English writes
 * tan/cot/arctan/sinh/cosh/tanh, and none of those have a TeX builtin — they
 * need \operatorname or they set as a product of italic variables (t·g).
 */
const BUILTIN = ["arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "sin", "cos", "tan",
    "cot", "sec", "csc", "log", "ln", "exp", "lim", "min", "max", "det", "deg", "dim", "gcd", "arg", "sup", "inf"];
const OPERATOR = ["arcctg", "arctg", "arcsh", "arcch", "ctg", "tg", "sh", "ch", "th",
    "lg", "rang", "rank", "const", "grad", "div", "rot", "tr", "sign", "res",
    "Re", "Im", "mes", "proj"];

const NAME_RE = new RegExp(
    `\\b(${[...BUILTIN, ...OPERATOR].sort((a, b) => b.length - a.length).join("|")})\\b`,
    "g",
);

const CYRILLIC = /[Ѐ-ӿ]/;

const CLOSER: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** Index of the bracket matching the one at `open`, or -1. */
function matchBracket(s: string, open: number): number {
    const o = s[open];
    const c = CLOSER[o];
    let depth = 0;
    for (let i = open; i < s.length; i++) {
        if (s[i] === o) depth++;
        else if (s[i] === c && --depth === 0) return i;
    }
    return -1;
}

/**
 * Length of the TeX macro call starting at `i` ("\frac{a}{b}" -> 11), or 0.
 *
 * Needed because a radical over a fraction reaches here as "√" followed by an
 * already-converted "\frac{…}{…}" — the fraction was a nested <table>, so it
 * became TeX before the radical around it was ever looked at.
 */
function macroLength(s: string, i: number): number {
    const m = /^\\[a-zA-Z]+/.exec(s.slice(i));
    if (!m) return 0;
    let j = i + m[0].length;
    while (s[j] === "{") {
        const close = matchBracket(s, j);
        if (close === -1) break;
        j = close + 1;
    }
    return j - i;
}

/**
 * √ is written as a bare character followed by its argument — "√(a² + b²)" or
 * "√3" — because HTML has no radical. TeX needs the argument braced, and an
 * unbraced \sqrt swallows exactly one token, so "\sqrt 3 + 1" would be right by
 * luck and "\sqrt (a+b)" would render a radical over nothing at all.
 */
function braceRadicals(s: string): string {
    let out = "";
    let i = 0;
    while (i < s.length) {
        if (s[i] !== "√") {
            out += s[i++];
            continue;
        }
        let j = i + 1;
        while (s[j] === " ") j++;

        // Bracketed argument. Square brackets are used interchangeably with
        // parentheses in this source when the expression already has round
        // ones inside it — "√[ (a)² + 1 ]".
        if (s[j] === "(" || s[j] === "[") {
            const close = matchBracket(s, j);
            if (close !== -1) {
                out += `\\sqrt{${braceRadicals(s.slice(j + 1, close))}}`;
                i = close + 1;
                continue;
            }
        }

        // A radical over a radical — "√√(1 - sin²3x)" in the half-angle
        // identity. The inner one has not been converted yet, so convert the
        // whole remainder first and then take the macro that comes back.
        if (s[j] === "√") {
            const rest = braceRadicals(s.slice(j));
            const len = macroLength(rest, 0);
            return `${out}\\sqrt{${rest.slice(0, len)}}${rest.slice(len)}`;
        }

        // A macro that a nested table already produced — almost always \frac.
        const macro = macroLength(s, j);
        if (macro) {
            out += `\\sqrt{${s.slice(j, j + macro)}}`;
            i = j + macro;
            continue;
        }
        // No parentheses: take the run of characters that reads as one operand
        // — a number, or a name with its sub/superscripts. A leading minus is
        // part of the operand and not an operator: "√-1" is the imaginary
        // unit's definition, written exactly that way in the source, and
        // reading the sign as subtraction turns it into "√ minus one".
        const m = /^-?[A-Za-z0-9]+(\^\{[^}]*\}|_\{[^}]*\})*/.exec(s.slice(j));
        if (m && m[0]) {
            out += `\\sqrt{${m[0]}}`;
            i = j + m[0].length;
            continue;
        }
        out += "\\sqrt{}";
        i = j;
    }
    return out;
}

/**
 * A fraction is not always a fraction.
 *
 * HTML has no way to stack a limit under an operator, so the author reaches for
 * the fraction table he already has: "lim" over "x→0", the upper limit of an
 * integral over "∫" and its lower one. Converted literally that becomes
 * \frac{\lim}{x \to 0}, which MathJax rejects outright — and where it doesn't,
 * it draws a horizontal rule through the middle of an integral.
 *
 * The giveaway is a big operator sitting alone in one half of the fraction.
 */
function unstackOperators(s: string): string {
    // \frac{\lim}{x \to 0}  ->  \lim_{x \to 0}
    let out = s.replace(
        /\\frac\{\s*\\(lim|sup|inf|max|min)\s*\}\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g,
        (_, op, below) => `\\${op}_{${below.trim()}}`,
    );
    // \frac{ABOVE}{\int BELOW}  ->  \int_{BELOW}^{ABOVE}. The operator is in
    // the denominator because that is where the author puts the lower limit,
    // and the glyph has to sit with it to stay on the baseline.
    out = out.replace(
        /\\frac\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\{\s*\\(int|iint|iiint|oint|sum|prod)\s*([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g,
        (_, above, op, below) => `\\${op}_{${below.trim()}}^{${above.trim()}}`,
    );
    return out;
}

/**
 * Substitute the symbol table, keeping macro names separable.
 *
 * A TeX macro name ends at the first non-letter, so "⊥a" mapped naively gives
 * "\perpa" — one undefined macro instead of a symbol and a variable, and the
 * whole formula fails. HTML needs no space there, so this source never writes
 * one, and it has to be inserted as the substitution is made.
 *
 * Not as a pass over the finished string: `/(\\[a-zA-Z]+)(?=[a-zA-Z])/` looks
 * like it does this, but the quantifier backtracks — it happily matches "\su"
 * inside "\sum" and turns a working sum into "\su m".
 */
function substituteSymbols(s: string): string {
    const chars = [...s];
    let out = "";
    for (let i = 0; i < chars.length; i++) {
        const mapped = SYMBOLS[chars[i]];
        if (mapped === undefined) {
            out += chars[i];
            continue;
        }
        out += mapped;
        if (/[a-zA-Z]$/.test(mapped) && /[a-zA-Z]/.test(chars[i + 1] ?? "")) out += " ";
    }
    return out;
}

/** TeX-ify one run that is known to contain no Cyrillic prose. */
function texify(s: string): string {
    // Dashes first: the source mixes hyphen, en dash and minus sign, and an
    // arrow written with an en dash ("–>") is invisible to the rule below —
    // which then leaves a literal "->" in the middle of a limit, because the
    // dash is normalised later by the symbol table.
    let out = s.replace(/[−–—]/g, "-");
    // ASCII arrows, written that way throughout: "x->0", "n=>∞".
    out = out.replace(/=>/g, "⇒").replace(/->/g, "→").replace(/<=(?!\s*[a-zA-Z0-9])/g, "≤");
    out = braceRadicals(out);
    out = out.replace(NAME_RE, (name) =>
        BUILTIN.includes(name) ? `\\${name}` : `\\operatorname{${name}}`,
    );
    // Symbols after the names, so that the letters of an \operatorname this
    // just inserted are never looked at again.
    out = substituteSymbols(out);
    // Any Cyrillic still here is a short identifier — a subscript label like
    // S_полн. Prose was lifted out before this ran (see splitCyrillic), and
    // MathJax would draw whatever is left as literally nothing.
    out = out.replace(/[Ѐ-ӿ]+/g, (run) => `\\mathrm{${translit(run)}}`);
    out = unstackOperators(out);
    // The author writes multiplication as "*", which TeX sets as a raised
    // asterisk rather than a product.
    return out.replace(/(?<![\\a-zA-Z])\*/g, " \\cdot ");
}

export interface Piece {
    kind: "math" | "text";
    value: string;
}

/**
 * Split a formula into the parts MathJax can set and the parts it cannot.
 *
 * A span like "|z| — модуль числа" is two things wearing one tag. Rendering it
 * whole gives blank boxes where the Russian was; dropping the Russian loses the
 * definition. Splitting gives a real formula next to real prose, which is what
 * the page says anyway.
 */
export function splitCyrillic(src: string): Piece[] {
    if (!CYRILLIC.test(src)) {
        const t = src.trim();
        return t ? [{ kind: "math", value: texify(t) }] : [];
    }

    const pieces: Piece[] = [];
    // A Cyrillic "run" greedily absorbs the punctuation and spaces around it so
    // that ", где" does not come back as three fragments.
    const re = /[Ѐ-ӿ][Ѐ-ӿ\s,.;:()«»„“”\-—]*/g;
    let last = 0;

    for (const m of src.matchAll(re)) {
        const run = m[0].trim();
        // Only PROSE is lifted out. A short bare word is an identifier — the
        // "полн" of S_полн or the "б" of F_б — and it lives inside braces the
        // formula needs. Cutting there leaves "F_{" on one side and "}" on the
        // other, and both halves fail to parse; texify transliterates these
        // in place instead.
        const isProse = /\s/.test(run) || run.length >= 9;
        // Even real prose is only cut at the top level. Inside a \frac or a
        // matrix cell, the braces around it are load-bearing.
        const depth = braceDepthAt(src, m.index);
        if (!isProse || depth > 0) continue;

        const before = src.slice(last, m.index).trim();
        if (before) pieces.push({ kind: "math", value: texify(before) });
        pieces.push({ kind: "text", value: run });
        last = m.index + m[0].length;
    }

    const tail = src.slice(last).trim();
    if (tail) pieces.push({ kind: "math", value: texify(tail) });
    return pieces.filter((p) => p.value !== "");
}

/** How many unclosed "{" precede `at`. */
function braceDepthAt(s: string, at: number): number {
    let depth = 0;
    for (let i = 0; i < at; i++) {
        if (s[i] === "{" && s[i - 1] !== "\\") depth++;
        else if (s[i] === "}" && s[i - 1] !== "\\") depth--;
    }
    return Math.max(0, depth);
}

/** The whole span as TeX, for display formulas that turned out to be pure maths. */
export function toTex(src: string): string {
    return texify(src.trim());
}

export const hasCyrillic = (s: string): boolean => CYRILLIC.test(s);
