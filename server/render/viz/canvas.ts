// The drawing surface every visualisation kind is built on, plus the constants
// that make one legible on the glasses.
//
// The panel is 576×252 per page, 4-bit greyscale mapped to green-on-black, read
// at arm's length. That rules out almost every charting default: hairlines
// vanish, a 10px label is unreadable, and two similar greys dither into speckle
// when sharp reduces the tile to 16 colours. So the palette here is three
// levels and nothing between them, strokes are thick, and identity is carried
// by dash pattern and a label at the end of the line — never by colour, and
// never by a legend the reader has to look away to decode.

/** Content width of .md-root: 576 minus its 16px side padding. */
export const VIZ_W = 544;

/**
 * Default and maximum height of a visualisation.
 *
 * The cap matters: a block taller than one page's worth of rows can never be
 * shown whole, however the paginator shuffles it (see keepTogether in
 * tiles.ts), so the renderers clamp rather than let a model ask for a figure
 * the glasses would always cut in half.
 */
export const VIZ_H_DEFAULT = 168;
export const VIZ_H_MAX = 190;
export const VIZ_H_MIN = 84;

/**
 * Three ink levels, spaced far enough apart to survive a 16-colour palette.
 * `guide` is deliberately not dim: at this size a 30%-grey axis reduces to a
 * dotted line.
 */
export const INK = {
    data: "#ffffff",
    guide: "#9a9a9a",
    label: "#ececec",
    caption: "#bdbdbd",
} as const;

export const STROKE = {
    data: 2.5,
    guide: 1.5,
    mark: 2,
} as const;

export const FONT_PX = {
    label: 16,
    tick: 13,
} as const;

/** Matches the body font in styles.ts, so a figure's labels look like the prose. */
export const FONT_FAMILY = `-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

/**
 * Series identity, in order: solid, long dash, dot. Three is the ceiling on
 * purpose — a fourth pattern is not tellable apart at this size, and a plot
 * that needs one wants two plots.
 */
export const DASHES = ["", "10 6", "2.5 5"] as const;

export function esc(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** Round to 2dp and drop the noise; SVG coordinates need no more. */
export function num(v: number): string {
    if (!Number.isFinite(v)) return "0";
    return String(Math.round(v * 100) / 100);
}

/** An axis tick or a value label: short, no trailing zeros. */
export function fmtNumber(v: number): string {
    if (!Number.isFinite(v)) return "";
    if (Math.abs(v) < 1e-9) return "0";
    const abs = Math.abs(v);
    const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
    return String(Number(v.toFixed(digits)));
}

// ── labels ──────────────────────────────────────────────────────────────────

const TEX_WORDS: Array<[RegExp, string]> = [
    [/\\alpha/g, "α"], [/\\beta/g, "β"], [/\\gamma/g, "γ"], [/\\delta/g, "δ"],
    [/\\theta/g, "θ"], [/\\lambda/g, "λ"], [/\\mu/g, "μ"], [/\\pi/g, "π"],
    [/\\rho/g, "ρ"], [/\\sigma/g, "σ"], [/\\phi/g, "φ"], [/\\omega/g, "ω"],
    [/\\Delta/g, "Δ"], [/\\Omega/g, "Ω"],
    [/\\times/g, "×"], [/\\cdot/g, "·"], [/\\pm/g, "±"], [/\\mp/g, "∓"],
    [/\\leq?\b/g, "≤"], [/\\geq?\b/g, "≥"], [/\\neq\b/g, "≠"], [/\\approx/g, "≈"],
    [/\\infty/g, "∞"], [/\\to\b/g, "→"], [/\\deg(ree)?\b/g, "°"],
    [/\\circ\b/g, "°"], [/\\in\b/g, "∈"], [/\\cup\b/g, "∪"], [/\\cap\b/g, "∩"],
];

const SUP: Record<string, string> = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
    "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
    "+": "⁺", "-": "⁻", n: "ⁿ", i: "ⁱ",
};
const SUB: Record<string, string> = {
    "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
    "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
    "+": "₊", "-": "₋", n: "ₙ", i: "ᵢ", x: "ₓ",
};

function script(body: string, table: Record<string, string>): string | null {
    let out = "";
    for (const ch of body) {
        const mapped = table[ch];
        if (!mapped) return null; // not expressible — leave the source alone
        out += mapped;
    }
    return out;
}

/**
 * A label is short plain text, and the model is told so — but this whole system
 * speaks LaTeX, so it will slip a `\pi` or an `x^2` in anyway. Rather than
 * print backslashes on the glasses, translate the handful of forms that have a
 * Unicode spelling and strip the rest.
 *
 * Full TeX is deliberately not supported here: MathJax's SVG would have to be
 * measured and positioned inside ours, and a figure label that needs real
 * layout is a figure label that is too long for this screen.
 */
export function mathText(raw: string): string {
    let s = String(raw);
    s = s.replace(/\$+/g, "");
    s = s.replace(/\\(?:vec|overline|bar)\{([^{}]*)\}/g, (_m, b) => `${b}⃗`);
    s = s.replace(/\\(?:mathbf|mathrm|text|operatorname)\{([^{}]*)\}/g, "$1");
    s = s.replace(/\\sqrt\{([^{}]*)\}/g, (_m, b) => `√${b}`);
    s = s.replace(/\\sqrt\s*(\d+)/g, (_m, b) => `√${b}`);
    s = s.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, (_m, a, b) => `${a}/${b}`);
    for (const [re, to] of TEX_WORDS) s = s.replace(re, to);
    s = s.replace(/\^\{?([^{}\s]+)\}?/g, (m, body: string) => script(body, SUP) ?? m);
    s = s.replace(/_\{?([^{}\s]+)\}?/g, (m, body: string) => script(body, SUB) ?? m);
    s = s.replace(/\\[a-zA-Z]+/g, "");
    s = s.replace(/[{}]/g, "");
    return s.trim();
}

// ── the surface ─────────────────────────────────────────────────────────────

export interface Pad {
    l: number;
    r: number;
    t: number;
    b: number;
}

export type Anchor = "start" | "middle" | "end";

export interface TextOpts {
    anchor?: Anchor;
    /** Vertical placement of the text box relative to y. */
    baseline?: "middle" | "top" | "bottom";
    size?: number;
    fill?: string;
    bold?: boolean;
}

export interface StrokeOpts {
    stroke?: string;
    width?: number;
    dash?: string;
    cap?: "round" | "butt";
    clip?: boolean;
}

/**
 * A fixed-size SVG with one data→pixel transform.
 *
 * Everything a kind draws goes through here in **pixels**, and the kind maps
 * its own units with x()/y(). Keeping the transform out of the primitives is
 * what lets a figure use equal scales on both axes (mandatory for geometry and
 * for vectors — an unequal scale draws a right angle that isn't one) while a
 * plot stretches each axis to fill the box.
 */
export class Canvas {
    readonly w: number;
    readonly h: number;
    readonly pad: Pad;
    private readonly parts: string[] = [];
    private readonly defs: string[] = [];
    private clipId: string | null = null;

    private ax = 1;
    private bx = 0;
    private ay = 1;
    private by = 0;

    constructor(w: number, h: number, pad: Partial<Pad> = {}) {
        this.w = w;
        this.h = h;
        this.pad = { l: pad.l ?? 8, r: pad.r ?? 8, t: pad.t ?? 8, b: pad.b ?? 8 };
    }

    get left(): number {
        return this.pad.l;
    }
    get right(): number {
        return this.w - this.pad.r;
    }
    get top(): number {
        return this.pad.t;
    }
    get bottom(): number {
        return this.h - this.pad.b;
    }
    get innerW(): number {
        return Math.max(1, this.right - this.left);
    }
    get innerH(): number {
        return Math.max(1, this.bottom - this.top);
    }

    /**
     * Map the data window onto the padded box. With `equal`, both axes take the
     * smaller of the two scales and the result is centred, so shapes keep their
     * proportions instead of being squashed to fill the frame.
     */
    fit(x0: number, x1: number, y0: number, y1: number, equal = false): void {
        const dx = x1 - x0 || 1;
        const dy = y1 - y0 || 1;
        let sx = this.innerW / dx;
        let sy = this.innerH / dy;
        if (equal) sx = sy = Math.min(sx, sy);

        this.ax = sx;
        this.bx = this.left + (this.innerW - dx * sx) / 2 - x0 * sx;
        // SVG y grows downward; data y grows up.
        this.ay = -sy;
        this.by = this.bottom - (this.innerH - dy * sy) / 2 + y0 * sy;
    }

    x(v: number): number {
        return this.ax * v + this.bx;
    }
    y(v: number): number {
        return this.ay * v + this.by;
    }

    /**
     * Pixels back to data.
     *
     * Needed because `equal` widens one axis: the scale is shared, so the window
     * actually on screen is larger than the one asked for, and a caller that
     * keeps drawing to the requested window leaves a band of empty panel and a
     * row of ticks that stops halfway across. Ask the canvas what is visible.
     */
    dataX(px: number): number {
        return (px - this.bx) / this.ax;
    }
    dataY(px: number): number {
        return (px - this.by) / this.ay;
    }
    /** Pixels per data unit on x — for sizing marks in data space. */
    get scaleX(): number {
        return this.ax;
    }
    get scaleY(): number {
        return -this.ay;
    }

    /**
     * Confine subsequent drawing to the padded box. A function that runs off the
     * top (or an asymptote) is clipped rather than dropped, so the curve reaches
     * the frame edge the way it does on paper.
     */
    clipToBox(): void {
        this.clipId = "vizclip";
        this.defs.push(
            `<clipPath id="${this.clipId}"><rect x="${num(this.left)}" y="${num(this.top)}" width="${num(this.innerW)}" height="${num(this.innerH)}"/></clipPath>`,
        );
    }

    private strokeAttrs(o: StrokeOpts): string {
        const a = [
            `fill="none"`,
            `stroke="${o.stroke ?? INK.data}"`,
            `stroke-width="${num(o.width ?? STROKE.data)}"`,
            `stroke-linejoin="round"`,
            `stroke-linecap="${o.cap ?? "round"}"`,
        ];
        if (o.dash) a.push(`stroke-dasharray="${o.dash}"`);
        if (o.clip && this.clipId) a.push(`clip-path="url(#${this.clipId})"`);
        return a.join(" ");
    }

    line(x1: number, y1: number, x2: number, y2: number, o: StrokeOpts = {}): void {
        this.parts.push(
            `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" ${this.strokeAttrs(o)}/>`,
        );
    }

    polyline(pts: Array<[number, number]>, o: StrokeOpts = {}): void {
        if (pts.length < 2) return;
        const d = pts.map(([px, py]) => `${num(px)},${num(py)}`).join(" ");
        this.parts.push(`<polyline points="${d}" ${this.strokeAttrs(o)}/>`);
    }

    path(d: string, o: StrokeOpts = {}): void {
        this.parts.push(`<path d="${d}" ${this.strokeAttrs(o)}/>`);
    }

    circle(cx: number, cy: number, r: number, o: StrokeOpts = {}): void {
        this.parts.push(
            `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" ${this.strokeAttrs(o)}/>`,
        );
    }

    /** A filled marker. `hollow` is the open endpoint of an interval. */
    dot(cx: number, cy: number, r = 4.5, hollow = false, fill = INK.data): void {
        this.parts.push(
            hollow
                ? `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" fill="#000000" stroke="${fill}" stroke-width="${num(STROKE.mark)}"/>`
                : `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" fill="${fill}"/>`,
        );
    }

    rect(x: number, y: number, w: number, h: number, fill: string, r = 0): void {
        if (w <= 0 || h <= 0) return;
        const round = r > 0 ? ` rx="${num(r)}" ry="${num(r)}"` : "";
        this.parts.push(
            `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" fill="${fill}"${round}/>`,
        );
    }

    text(x: number, y: number, raw: string, o: TextOpts = {}): void {
        const body = esc(mathText(raw));
        if (!body) return;
        const size = o.size ?? FONT_PX.label;
        // dominant-baseline is honoured by the Chromium that rasterises this;
        // "top"/"bottom" are expressed as a hanging/alphabetic baseline plus a
        // nudge, which is steadier across glyph sets than text-before-edge.
        const dy = o.baseline === "top" ? size * 0.82 : o.baseline === "bottom" ? 0 : size * 0.34;
        this.parts.push(
            `<text x="${num(x)}" y="${num(y + dy)}" font-family='${FONT_FAMILY}' font-size="${num(size)}"` +
                ` fill="${o.fill ?? INK.label}" text-anchor="${o.anchor ?? "start"}"` +
                (o.bold ? ` font-weight="700"` : "") +
                `>${body}</text>`,
        );
    }

    /**
     * An arrow from (x1,y1) to (x2,y2), head included.
     *
     * The head is a filled triangle drawn here rather than an SVG marker: a
     * marker inherits stroke width, and at 2.5px these would come out as
     * blobs — and markers are the one SVG feature html2canvas-era pipelines
     * have historically dropped, so drawing it is also the safe choice.
     */
    arrow(x1: number, y1: number, x2: number, y2: number, o: StrokeOpts & { head?: number } = {}): void {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        if (len < 0.5) return;
        const head = Math.min(o.head ?? 11, len * 0.6);
        const ux = dx / len;
        const uy = dy / len;
        // Stop the shaft just short of the tip so the line doesn't poke through
        // the head's point.
        const sx = x2 - ux * head * 0.85;
        const sy = y2 - uy * head * 0.85;
        this.line(x1, y1, sx, sy, o);
        const wing = head * 0.42;
        const bx = x2 - ux * head;
        const by = y2 - uy * head;
        const d =
            `M ${num(x2)} ${num(y2)} L ${num(bx - uy * wing)} ${num(by + ux * wing)}` +
            ` L ${num(bx + uy * wing)} ${num(by - ux * wing)} Z`;
        const clip = o.clip && this.clipId ? ` clip-path="url(#${this.clipId})"` : "";
        this.parts.push(`<path d="${d}" fill="${o.stroke ?? INK.data}"${clip}/>`);
    }

    /** Arc through pixel space, used for angle marks. */
    arc(cx: number, cy: number, r: number, a0: number, a1: number, o: StrokeOpts = {}): void {
        const p0x = cx + r * Math.cos(a0);
        const p0y = cy + r * Math.sin(a0);
        const p1x = cx + r * Math.cos(a1);
        const p1y = cy + r * Math.sin(a1);
        let sweep = a1 - a0;
        while (sweep <= -Math.PI) sweep += 2 * Math.PI;
        while (sweep > Math.PI) sweep -= 2 * Math.PI;
        const large = 0;
        const dir = sweep > 0 ? 1 : 0;
        this.path(
            `M ${num(p0x)} ${num(p0y)} A ${num(r)} ${num(r)} 0 ${large} ${dir} ${num(p1x)} ${num(p1y)}`,
            o,
        );
    }

    render(): string {
        return (
            `<svg xmlns="http://www.w3.org/2000/svg" width="${this.w}" height="${this.h}"` +
            ` viewBox="0 0 ${this.w} ${this.h}" role="img">` +
            (this.defs.length ? `<defs>${this.defs.join("")}</defs>` : "") +
            this.parts.join("") +
            `</svg>`
        );
    }
}

/**
 * The box to draw equal-scale content in.
 *
 * Geometry and vectors must keep their proportions, and the panel is 3:1 — so a
 * tall figure stretched across the full width is mostly empty axis with the
 * drawing shrunk into the middle of it. Instead the SVG itself is only as wide
 * as the content needs at the largest scale that fits the available height, and
 * the CSS centres it. The figure comes out as big as it can be, with nothing
 * around it pretending to be part of the picture.
 */
export function equalBox(
    dx: number,
    dy: number,
    pad: Pad,
    maxH = VIZ_H_MAX,
): { w: number; h: number } {
    const spanX = Math.abs(dx) || 1;
    const spanY = Math.abs(dy) || 1;
    const availW = VIZ_W - pad.l - pad.r;
    const availH = Math.max(1, Math.min(VIZ_H_MAX, maxH) - pad.t - pad.b);
    const scale = Math.min(availW / spanX, availH / spanY);
    return {
        w: Math.min(VIZ_W, Math.round(spanX * scale + pad.l + pad.r)),
        h: Math.max(VIZ_H_MIN, Math.min(VIZ_H_MAX, Math.round(spanY * scale + pad.t + pad.b))),
    };
}

/**
 * A 1, 2 or 5 × 10ⁿ step giving at most `maxTicks` intervals — the steps a
 * person would have chosen, and never a 0.30000000000000004.
 */
export function niceStep(range: number, maxTicks: number): number {
    const raw = Math.abs(range) / Math.max(1, maxTicks);
    if (!(raw > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 5]) {
        if (mag * m >= raw) return mag * m;
    }
    return mag * 10;
}

/**
 * The tick step for an axis `px` pixels long showing `range` units.
 *
 * Two constraints, and both matter on a panel this size: labels closer than
 * `minPx` collide, and more than `maxCount` of them turn the axis into a ruler
 * nobody reads. Walking the 1-2-5 ladder upward and taking the first step that
 * satisfies both gives the finest readable axis — which a step derived from the
 * range alone does not, because the same range is 490px wide on a function plot
 * and 130px wide on an equal-scale vector diagram.
 */
export function chooseStep(range: number, px: number, minPx = 34, maxCount = 9): number {
    const span = Math.abs(range) || 1;
    const per = px / span;
    let mag = Math.pow(10, Math.floor(Math.log10(span)) - 2);
    for (let decade = 0; decade < 14; decade++) {
        for (const m of [1, 2, 5]) {
            const step = mag * m;
            if (step * per >= minPx && span / step <= maxCount) return step;
        }
        mag *= 10;
    }
    return niceStep(span, maxCount);
}

/** Multiples of `step` inside [lo, hi], nudged for float error. */
export function ticksIn(lo: number, hi: number, step: number): number[] {
    const out: number[] = [];
    const start = Math.ceil(lo / step - 1e-6);
    const end = Math.floor(hi / step + 1e-6);
    // A pathological step can't be allowed to spin here.
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start > 400) return out;
    for (let i = start; i <= end; i++) out.push(i * step);
    return out;
}
