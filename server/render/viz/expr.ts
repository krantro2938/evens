// "x^2 - 3" -> a function of x, without eval.
//
// The string arrives inside a solution posted over HTTP by an agent, so
// `new Function(src)` would be arbitrary code execution on this server for the
// sake of plotting a parabola. A recursive-descent parser over a fixed table of
// functions and constants costs a hundred lines and closes that door completely.
//
// It is also lenient in the two ways this system guarantees will be needed: the
// whole pipeline speaks LaTeX, so `\frac{1}{2}\pi x` is normalised before
// parsing; and school notation omits multiplication signs, so `2x`, `3(x+1)`
// and `2\pi x` all parse.

const CONSTANTS: Record<string, number> = {
    pi: Math.PI,
    tau: Math.PI * 2,
    e: Math.E,
};

const FUNCS: Record<string, (...args: number[]) => number> = {
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,
    arcsin: Math.asin,
    arccos: Math.acos,
    arctan: Math.atan,
    sinh: Math.sinh,
    cosh: Math.cosh,
    tanh: Math.tanh,
    sqrt: Math.sqrt,
    cbrt: Math.cbrt,
    abs: Math.abs,
    exp: Math.exp,
    ln: Math.log,
    log: Math.log, // school "log" with no base is natural in most of these papers
    lg: Math.log10,
    log10: Math.log10,
    log2: Math.log2,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
    sign: Math.sign,
    min: Math.min,
    max: Math.max,
    pow: Math.pow,
};

/** Find the `{...}` group starting at `open`, respecting nesting. */
function matchBrace(src: string, open: number): number {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/** `\frac{a}{b}` -> `((a)/(b))`, innermost first so nesting resolves. */
function expandFrac(src: string): string {
    let out = src;
    for (let guard = 0; guard < 12; guard++) {
        const at = out.search(/\\(?:frac|dfrac|tfrac)\s*\{/);
        if (at < 0) break;
        const o1 = out.indexOf("{", at);
        const c1 = matchBrace(out, o1);
        if (c1 < 0) break;
        const o2 = out.indexOf("{", c1);
        if (o2 < 0) break;
        const c2 = matchBrace(out, o2);
        if (c2 < 0) break;
        const a = out.slice(o1 + 1, c1);
        const b = out.slice(o2 + 1, c2);
        out = `${out.slice(0, at)}((${a})/(${b}))${out.slice(c2 + 1)}`;
    }
    return out;
}

/** Strip the TeX a model will inevitably mix in, leaving plain infix. */
export function deLatex(src: string): string {
    let s = String(src);
    s = s.replace(/\$/g, "");
    s = s.replace(/\\left|\\right|\\!|\\,|\\;|\\:|\\quad|\\qquad/g, "");
    s = s.replace(/\\(?:cdot|times|ast)\b/g, "*");
    s = s.replace(/\\div\b/g, "/");
    s = expandFrac(s);
    s = s.replace(/\\sqrt\s*\[\s*([^\]]*)\]\s*\{([^{}]*)\}/g, "($2)^(1/($1))");
    // `\sqrt2` and `\sqrt x` are written without braces as often as with them,
    // and the bare rewrite below would leave `sqrt2` — one identifier, no call.
    s = s.replace(/\\sqrt\s*([0-9]*\.?[0-9]+|[a-zA-Z])/g, "sqrt($1)");
    s = s.replace(/\\sqrt/g, "sqrt");
    s = s.replace(/\\operatorname\s*\{([^{}]*)\}/g, "$1");
    s = s.replace(/\\(?:mathrm|mathbf|text)\s*\{([^{}]*)\}/g, "$1");
    // Remaining known names lose their backslash; unknown ones are dropped so a
    // stray macro can't turn into an identifier.
    s = s.replace(/\\([a-zA-Z]+)/g, (_m, name: string) =>
        name in FUNCS || name.toLowerCase() in CONSTANTS ? name : "",
    );
    // Braces only ever grouped in TeX; parentheses mean the same thing here.
    s = s.replace(/[{}]/g, (c) => (c === "{" ? "(" : ")"));
    s = s.replace(/[−–—]/g, "-"); // unicode minus / dashes
    s = s.replace(/[·∙⋅]/g, "*");
    s = s.replace(/÷/g, "/");
    s = s.replace(/π/g, "pi");
    s = s.replace(/²/g, "^2").replace(/³/g, "^3");
    return s;
}

type Tok =
    | { t: "num"; v: number }
    | { t: "name"; v: string }
    | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
    const out: Tok[] = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i]!;
        if (c === " " || c === "\t" || c === "\n" || c === "\r") {
            i++;
            continue;
        }
        if (/[0-9.]/.test(c)) {
            const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?|^[0-9]+\.?/.exec(src.slice(i));
            if (!m) throw new Error(`bad number at ${i}`);
            out.push({ t: "num", v: Number(m[0]) });
            i += m[0].length;
            continue;
        }
        if (/[a-zA-Z]/.test(c)) {
            const m = /^[a-zA-Z][a-zA-Z0-9]*/.exec(src.slice(i))!;
            out.push({ t: "name", v: m[0] });
            i += m[0].length;
            continue;
        }
        if ("+-*/^(),".includes(c)) {
            out.push({ t: "op", v: c });
            i++;
            continue;
        }
        throw new Error(`unexpected "${c}"`);
    }
    return out;
}

/**
 * The variable a single-argument expression is a function of. Anything else that
 * is neither a constant nor a function name is a parse error, so a typo becomes
 * a caption instead of a silently flat line at NaN.
 */
export interface CompiledExpr {
    (x: number): number;
    /** The source, cleaned — used as the fallback series label. */
    readonly source: string;
}

export function compileExpr(source: string, variable = "x"): CompiledExpr {
    const cleaned = deLatex(source).trim();
    if (!cleaned) throw new Error("empty expression");
    const toks = tokenize(cleaned);
    let pos = 0;
    const varName = variable.toLowerCase();

    const peek = (): Tok | undefined => toks[pos];
    const isOp = (v: string): boolean => {
        const t = peek();
        return !!t && t.t === "op" && t.v === v;
    };
    const eat = (v: string): boolean => {
        if (!isOp(v)) return false;
        pos++;
        return true;
    };
    const expect = (v: string): void => {
        if (!eat(v)) throw new Error(`expected "${v}"`);
    };

    type Node = (x: number) => number;

    // Implicit multiplication: a primary followed directly by a number, a name
    // or "(" — `2x`, `2(x+1)`, `x(x-1)`, `2pi`.
    const startsPrimary = (): boolean => {
        const t = peek();
        if (!t) return false;
        return t.t === "num" || t.t === "name" || (t.t === "op" && t.v === "(");
    };

    function parseExpr(): Node {
        let node = parseTerm();
        for (;;) {
            if (eat("+")) {
                const rhs = parseTerm();
                const lhs = node;
                node = (x) => lhs(x) + rhs(x);
            } else if (eat("-")) {
                const rhs = parseTerm();
                const lhs = node;
                node = (x) => lhs(x) - rhs(x);
            } else return node;
        }
    }

    function parseTerm(): Node {
        let node = parseUnary();
        for (;;) {
            if (eat("*")) {
                const rhs = parseUnary();
                const lhs = node;
                node = (x) => lhs(x) * rhs(x);
            } else if (eat("/")) {
                const rhs = parseUnary();
                const lhs = node;
                node = (x) => lhs(x) / rhs(x);
            } else if (startsPrimary()) {
                const rhs = parseUnary();
                const lhs = node;
                node = (x) => lhs(x) * rhs(x);
            } else return node;
        }
    }

    function parseUnary(): Node {
        if (eat("-")) {
            const inner = parseUnary();
            return (x) => -inner(x);
        }
        if (eat("+")) return parseUnary();
        return parsePower();
    }

    function parsePower(): Node {
        const base = parsePrimary();
        // Right-associative, and the exponent may be signed: 2^-x.
        if (eat("^")) {
            const exp = parseUnary();
            return (x) => Math.pow(base(x), exp(x));
        }
        return base;
    }

    function parsePrimary(): Node {
        const t = peek();
        if (!t) throw new Error("unexpected end of expression");
        if (t.t === "num") {
            pos++;
            const v = t.v;
            return () => v;
        }
        if (t.t === "op" && t.v === "(") {
            pos++;
            const inner = parseExpr();
            expect(")");
            return inner;
        }
        if (t.t === "name") {
            pos++;
            const name = t.v;
            const lower = name.toLowerCase();
            if (isOp("(") && lower in FUNCS) {
                pos++;
                const args: Node[] = [parseExpr()];
                while (eat(",")) args.push(parseExpr());
                expect(")");
                const fn = FUNCS[lower]!;
                return (x) => fn(...args.map((a) => a(x)));
            }
            if (name === variable || lower === varName) return (x) => x;
            if (lower in CONSTANTS) {
                const v = CONSTANTS[lower]!;
                return () => v;
            }
            // A bare function name with no parens (`sin x`) lands here too, and
            // is refused on purpose: guessing where its argument ends is how you
            // plot the wrong curve.
            throw new Error(`unknown name "${name}"`);
        }
        throw new Error(`unexpected "${t.t === "op" ? t.v : String(t)}"`);
    }

    const root = parseExpr();
    if (pos !== toks.length) throw new Error("trailing input");

    const fn = ((x: number) => {
        const v = root(x);
        return typeof v === "number" ? v : NaN;
    }) as { (x: number): number; source: string };
    fn.source = cleaned;
    return fn as CompiledExpr;
}

/** A number, or an expression evaluated with no variable (`2*pi/3`, `\sqrt2`). */
export function toNumber(value: unknown): number {
    if (typeof value === "number") return value;
    if (typeof value !== "string" || !value.trim()) return NaN;
    const direct = Number(value);
    if (Number.isFinite(direct)) return direct;
    try {
        return compileExpr(value)(NaN);
    } catch {
        return NaN;
    }
}
