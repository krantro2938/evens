// The visualisation kinds, each a pure spec -> SVG function.
//
// Four kinds, chosen because they are what a school paper actually needs and
// because each is legible when reduced to 544×170 pixels of two-tone green:
//
//   plot        a coordinate system: functions, points, vectors
//   figure      geometry with no axes: points, segments, circles, angles
//   bars        magnitude across a handful of named categories
//   number-line a 1-D axis: solution sets, intervals, inequalities
//
// What is deliberately absent is as important. No pie (a part-to-whole with no
// readable angles at this size), no second y-axis, no colour encoding and no
// legend box: series identity is a dash pattern plus a label at the end of the
// line, because a legend on this screen means looking away from the data to
// decode it, and colour does not exist here at all.

import {
    Canvas,
    DASHES,
    FONT_PX,
    INK,
    STROKE,
    VIZ_H_DEFAULT,
    VIZ_H_MAX,
    VIZ_H_MIN,
    VIZ_W,
    chooseStep,
    equalBox,
    fmtNumber,
    ticksIn,
} from "./canvas";
import { compileExpr, toNumber } from "./expr";

export type Spec = Record<string, unknown>;

/** Thrown for a spec that cannot be drawn; the caller shows the caption instead. */
export class VizError extends Error {}

function fail(message: string): never {
    throw new VizError(message);
}

// ── spec reading ────────────────────────────────────────────────────────────
// Everything below assumes a model wrote the spec, so each reader accepts the
// forms a model actually produces rather than one canonical shape: a point is
// `[x, y]` or `{at: [x, y]}` or the name of a point defined elsewhere, a segment
// is `["A","B"]` or `"AB"` or `{from, to}`.

type Pt = [number, number];

function asArray(value: unknown): unknown[] {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

function asPair(value: unknown, what: string): Pt {
    if (!Array.isArray(value) || value.length < 2) fail(`${what} must be [x, y]`);
    const x = toNumber(value[0]);
    const y = toNumber(value[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) fail(`${what} has a non-numeric coordinate`);
    return [x, y];
}

function asRange(value: unknown, what: string): [number, number] {
    const [a, b] = asPair(value, what);
    if (a === b) fail(`${what} is empty`);
    return a < b ? [a, b] : [b, a];
}

function str(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/**
 * Each coordinate can be finite while the window is not: 1e308 and -1e308 are
 * both valid numbers whose difference overflows, and a span of Infinity divides
 * through the fit into a canvas sized `NaN` — an SVG that renders as nothing.
 */
function checkWindow(x0: number, x1: number, y0: number, y1: number): void {
    if (![x0, x1, y0, y1, x1 - x0, y1 - y0].every(Number.isFinite)) {
        fail("the coordinates are out of range");
    }
}

function clampHeight(value: unknown): number {
    const h = toNumber(value);
    if (!Number.isFinite(h)) return VIZ_H_DEFAULT;
    return Math.max(VIZ_H_MIN, Math.min(VIZ_H_MAX, Math.round(h)));
}

// ── plot ────────────────────────────────────────────────────────────────────

interface Series {
    fn: (x: number) => number;
    label: string;
    dash: string;
}

const SAMPLES = 480;

function readSeries(spec: Spec): Series[] {
    const raw = asArray(spec.fns ?? spec.functions ?? spec.f);
    const out: Series[] = [];
    for (const item of raw.slice(0, DASHES.length)) {
        const source = typeof item === "string" ? item : str((item as Spec)?.f ?? (item as Spec)?.fn);
        if (!source) fail("a function entry has no expression");
        let fn;
        try {
            fn = compileExpr(source, str((item as Spec)?.var) || "x");
        } catch (err) {
            fail(`cannot read "${source}": ${(err as Error).message}`);
        }
        const explicit = typeof item === "string" ? "" : str((item as Spec)?.label);
        out.push({
            fn,
            label: explicit,
            // Index picks the pattern, so the first series is always the solid
            // one and a re-render can't reshuffle which curve is which.
            dash: DASHES[out.length]!,
        });
    }
    return out;
}

export function renderPlot(spec: Spec): string {
    const series = readSeries(spec);
    const points = asArray(spec.points).map((p) => {
        const at = Array.isArray(p) ? asPair(p, "point") : asPair((p as Spec)?.at, "point.at");
        return { at, label: str((p as Spec)?.label), open: Boolean((p as Spec)?.open) };
    });
    const vectors = asArray(spec.vectors).map((v) => {
        const item = v as Spec;
        const to = item?.to !== undefined ? asPair(item.to, "vector.to") : asPair(v, "vector");
        const from = item?.from !== undefined ? asPair(item.from, "vector.from") : ([0, 0] as Pt);
        return { from, to, label: str(item?.label) };
    });
    const segments = asArray(spec.segments).map((s) => {
        const item = s as Spec;
        if (item?.from !== undefined && item?.to !== undefined) {
            return {
                a: asPair(item.from, "segment.from"),
                b: asPair(item.to, "segment.to"),
                dash: Boolean(item.dash),
            };
        }
        const pair = asArray(s);
        return { a: asPair(pair[0], "segment"), b: asPair(pair[1], "segment"), dash: false };
    });

    if (!series.length && !points.length && !vectors.length && !segments.length) {
        fail("nothing to plot");
    }

    // Vectors and bare geometry are about direction, so their scales must match
    // or the picture lies about every angle it shows. Functions are not, and
    // forcing equal scales on y = x² wastes most of the panel.
    const equal =
        spec.equal !== undefined
            ? Boolean(spec.equal)
            : !series.length && (vectors.length > 0 || segments.length > 0);

    const literalX: number[] = [];
    const literalY: number[] = [];
    for (const p of points) {
        literalX.push(p.at[0]);
        literalY.push(p.at[1]);
    }
    for (const v of vectors) {
        literalX.push(v.from[0], v.to[0]);
        literalY.push(v.from[1], v.to[1]);
    }
    for (const s of segments) {
        literalX.push(s.a[0], s.b[0]);
        literalY.push(s.a[1], s.b[1]);
    }

    let x0: number;
    let x1: number;
    if (spec.x !== undefined) {
        [x0, x1] = asRange(spec.x, "x");
    } else if (literalX.length) {
        const lo = Math.min(0, ...literalX);
        const hi = Math.max(0, ...literalX);
        const pad = (hi - lo || 1) * 0.15;
        x0 = lo - pad;
        x1 = hi + pad;
    } else {
        x0 = -5;
        x1 = 5;
    }

    const sampleOver = (from: number, to: number) => {
        const step = (to - from) / (SAMPLES - 1);
        return series.map((s) => {
            const pts: Array<[number, number]> = [];
            for (let i = 0; i < SAMPLES; i++) {
                const x = from + i * step;
                pts.push([x, s.fn(x)]);
            }
            return pts;
        });
    };

    // Sample first: the y window is derived from what the functions actually do
    // over the chosen x window, not guessed.
    let sampled = sampleOver(x0, x1);

    let y0: number;
    let y1: number;
    if (spec.y !== undefined) {
        [y0, y1] = asRange(spec.y, "y");
    } else {
        const ys = literalY.filter(Number.isFinite);
        for (const pts of sampled) {
            for (const [, y] of pts) {
                // An asymptote must not be allowed to set the window, or the
                // interesting part of the curve is a flat line at the axis.
                if (Number.isFinite(y) && Math.abs(y) < 1e4) ys.push(y);
            }
        }
        if (!ys.length) fail("the functions produce no finite values on this interval");
        let lo = Math.min(...ys);
        let hi = Math.max(...ys);
        if (hi - lo < 1e-9) {
            lo -= 1;
            hi += 1;
        }
        const spread = hi - lo;
        // Reach for zero when it is nearby: a graph whose axis is off-screen
        // reads as the wrong graph.
        if (lo > 0 && lo < spread) lo = 0;
        if (hi < 0 && -hi < spread) hi = 0;
        const pad = (hi - lo) * 0.1;
        y0 = lo - pad;
        y1 = hi + pad;
    }

    checkWindow(x0, x1, y0, y1);

    const xLabel = str(spec.xlabel);
    const yLabel = str(spec.ylabel);
    const pad = {
        l: 34,
        r: 18 + (xLabel ? 14 : 0),
        t: 14 + (yLabel ? 6 : 0),
        b: 24,
    };
    // An equal-scale plot is sized to its content; a plot of functions fills the
    // panel, because stretching y to fit is exactly what a graph of y = x² wants.
    const box = equal
        ? equalBox(x1 - x0, y1 - y0, pad, spec.height === undefined ? VIZ_H_MAX : clampHeight(spec.height))
        : { w: VIZ_W, h: clampHeight(spec.height) };
    const c = new Canvas(box.w, box.h, pad);
    c.fit(x0, x1, y0, y1, equal);
    c.clipToBox();

    // With equal scales the box shows more than was asked for on one axis. From
    // here on the *visible* window is the window: functions are resampled across
    // it so a curve reaches both edges, and ticks run the full width instead of
    // stopping in the middle of the panel.
    const vx0 = c.dataX(c.left);
    const vx1 = c.dataX(c.right);
    const vy0 = c.dataY(c.bottom);
    const vy1 = c.dataY(c.top);
    if (vx1 - vx0 > (x1 - x0) * 1.001) sampled = sampleOver(vx0, vx1);

    // Axes sit at zero when zero is in view and at the frame edge when it is
    // not, which is how the same spec draws both a school parabola (crossed
    // axes) and a positive-only plot (L-shaped axes).
    const axisY = vy0 <= 0 && vy1 >= 0 ? c.y(0) : c.bottom;
    const axisX = vx0 <= 0 && vx1 >= 0 ? c.x(0) : c.left;

    // Steps come from the visible window and the pixels available for it — see
    // chooseStep for why the data range alone is not enough to go on.
    const xStep = toNumber(spec.xstep) > 0 ? toNumber(spec.xstep) : chooseStep(vx1 - vx0, c.innerW, 36, 9);
    const yStep = toNumber(spec.ystep) > 0 ? toNumber(spec.ystep) : chooseStep(vy1 - vy0, c.innerH, 30, 7);

    for (const t of ticksIn(vx0, vx1, xStep)) {
        const px = c.x(t);
        if (px < c.left - 1 || px > c.right + 1) continue;
        c.line(px, axisY - 4, px, axisY + 4, { stroke: INK.guide, width: STROKE.guide });
        if (Math.abs(t) < xStep / 2) continue; // the origin is labelled once, below
        c.text(px, axisY + 7, fmtNumber(t), {
            anchor: "middle",
            baseline: "top",
            size: FONT_PX.tick,
            fill: INK.guide,
        });
    }
    for (const t of ticksIn(vy0, vy1, yStep)) {
        const py = c.y(t);
        if (py < c.top - 1 || py > c.bottom + 1) continue;
        c.line(axisX - 4, py, axisX + 4, py, { stroke: INK.guide, width: STROKE.guide });
        if (Math.abs(t) < yStep / 2) continue;
        c.text(axisX - 7, py, fmtNumber(t), {
            anchor: "end",
            size: FONT_PX.tick,
            fill: INK.guide,
        });
    }
    if (vx0 <= 0 && vx1 >= 0 && vy0 <= 0 && vy1 >= 0) {
        c.text(axisX - 6, axisY + 6, "0", {
            anchor: "end",
            baseline: "top",
            size: FONT_PX.tick,
            fill: INK.guide,
        });
    }

    // Arrowheads on the positive ends, the way the axes are drawn on paper.
    c.arrow(c.left, axisY, c.right, axisY, { stroke: INK.guide, width: STROKE.guide, head: 9 });
    c.arrow(axisX, c.bottom, axisX, c.top, { stroke: INK.guide, width: STROKE.guide, head: 9 });
    if (xLabel) c.text(c.right + 2, axisY - 10, xLabel, { anchor: "end", size: FONT_PX.tick, fill: INK.guide });
    if (yLabel) c.text(axisX + 6, c.top - 2, yLabel, { size: FONT_PX.tick, fill: INK.guide });

    for (const a of asArray((spec.asymptotes as Spec)?.x)) {
        const v = toNumber(a);
        if (!Number.isFinite(v) || v < vx0 || v > vx1) continue;
        c.line(c.x(v), c.top, c.x(v), c.bottom, { stroke: INK.guide, width: STROKE.guide, dash: "5 5" });
    }
    for (const a of asArray((spec.asymptotes as Spec)?.y)) {
        const v = toNumber(a);
        if (!Number.isFinite(v) || v < vy0 || v > vy1) continue;
        c.line(c.left, c.y(v), c.right, c.y(v), { stroke: INK.guide, width: STROKE.guide, dash: "5 5" });
    }

    for (const s of segments) {
        c.line(c.x(s.a[0]), c.y(s.a[1]), c.x(s.b[0]), c.y(s.b[1]), {
            dash: s.dash ? "8 5" : undefined,
            clip: true,
        });
    }

    // A jump larger than twice the window is an asymptote, not a line: draw the
    // runs on either side and leave the gap, or 1/x gets a vertical stroke
    // through the origin that reads as part of the curve.
    const jumpLimit = (vy1 - vy0) * 2;
    sampled.forEach((pts, i) => {
        const s = series[i]!;
        let run: Array<[number, number]> = [];
        let prev: number | null = null;
        const flush = () => {
            if (run.length > 1) c.polyline(run, { dash: s.dash || undefined, clip: true });
            run = [];
        };
        for (const [x, y] of pts) {
            if (!Number.isFinite(y) || (prev !== null && Math.abs(y - prev) > jumpLimit)) {
                flush();
                prev = Number.isFinite(y) ? y : null;
                if (prev !== null) run.push([c.x(x), c.y(y)]);
                continue;
            }
            run.push([c.x(x), c.y(y)]);
            prev = y;
        }
        flush();

        if (!s.label) return;
        // Label at the curve's own right-hand end, so identity is read where the
        // eye already is instead of in a legend.
        for (let k = pts.length - 1; k >= 0; k--) {
            const [x, y] = pts[k]!;
            if (!Number.isFinite(y) || y < vy0 || y > vy1) continue;
            c.text(c.x(x) - 3, c.y(y) - 12, s.label, { anchor: "end", size: FONT_PX.tick, bold: true });
            break;
        }
    });

    for (const v of vectors) {
        c.arrow(c.x(v.from[0]), c.y(v.from[1]), c.x(v.to[0]), c.y(v.to[1]), { clip: true });
        if (!v.label) continue;
        // Beside the head, pushed off the shaft so the arrow stays readable.
        const dx = c.x(v.to[0]) - c.x(v.from[0]);
        const dy = c.y(v.to[1]) - c.y(v.from[1]);
        const len = Math.hypot(dx, dy) || 1;
        c.text(c.x(v.to[0]) + (dy / len) * 12 + (dx / len) * 4, c.y(v.to[1]) - (dx / len) * 12 + (dy / len) * 4, v.label, {
            anchor: dx >= 0 ? "start" : "end",
            bold: true,
        });
    }

    for (const p of points) {
        if (p.at[0] < vx0 || p.at[0] > vx1 || p.at[1] < vy0 || p.at[1] > vy1) continue;
        c.dot(c.x(p.at[0]), c.y(p.at[1]), 4.5, p.open);
        // Up and to the right of the marker, clear of both the dot and the curve
        // it sits on.
        if (p.label) {
            c.text(c.x(p.at[0]) + 8, c.y(p.at[1]) - 14, p.label, {
                baseline: "bottom",
                size: FONT_PX.label,
                bold: true,
            });
        }
    }

    return c.render();
}

// ── figure ──────────────────────────────────────────────────────────────────

type PointMap = Map<string, Pt>;

function readPoints(spec: Spec): PointMap {
    const map: PointMap = new Map();
    const raw = spec.points;
    if (Array.isArray(raw)) {
        for (const item of raw) {
            const p = item as Spec;
            const name = str(p?.name ?? p?.label);
            const at = p?.at !== undefined ? asPair(p.at, "point.at") : asPair(item, "point");
            map.set(name || `P${map.size + 1}`, at);
        }
    } else if (raw && typeof raw === "object") {
        for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
            map.set(name, asPair(value, `point ${name}`));
        }
    }
    return map;
}

/** A named point, an inline `[x, y]`, or a name that was never defined. */
function resolve(value: unknown, pts: PointMap, what: string): Pt {
    if (typeof value === "string") {
        const hit = pts.get(value) ?? pts.get(value.trim());
        if (!hit) fail(`${what} refers to undefined point "${value}"`);
        return hit;
    }
    return asPair(value, what);
}

interface Edge {
    a: Pt;
    b: Pt;
    dash: boolean;
    label: string;
    marks: number;
}

function readEdges(spec: Spec, pts: PointMap): Edge[] {
    const edges: Edge[] = [];
    const push = (a: unknown, b: unknown, item?: Spec) => {
        edges.push({
            a: resolve(a, pts, "segment"),
            b: resolve(b, pts, "segment"),
            dash: Boolean(item?.dash),
            label: str(item?.label),
            marks: Math.max(0, Math.min(3, Math.round(toNumber(item?.marks) || 0))),
        });
    };

    for (const item of asArray(spec.segments ?? spec.lines)) {
        // "AB" is how a person writes a segment, so accept it.
        if (typeof item === "string") {
            const names = item.includes("-") ? item.split("-") : [...item];
            if (names.length !== 2) fail(`cannot read segment "${item}"`);
            push(names[0], names[1]);
            continue;
        }
        const s = item as Spec;
        if (s?.from !== undefined) {
            push(s.from, s.to, s);
            continue;
        }
        const pair = asArray(item);
        if (pair.length < 2) fail("a segment needs two ends");
        push(pair[0], pair[1], s);
    }

    // A polygon is the closed walk of its vertices — the common case, and
    // spelling it out as segments is where a model drops the closing edge.
    for (const poly of asArray(spec.polygons ?? spec.polygon)) {
        const names = typeof poly === "string" ? [...poly] : asArray(poly);
        if (names.length < 3) fail("a polygon needs three vertices");
        for (let i = 0; i < names.length; i++) {
            push(names[i], names[(i + 1) % names.length]);
        }
    }
    return edges;
}

export function renderFigure(spec: Spec): string {
    const pts = readPoints(spec);
    const edges = readEdges(spec, pts);
    const circles = asArray(spec.circles).map((item) => {
        const c = item as Spec;
        const at = resolve(c?.at ?? c?.center ?? [0, 0], pts, "circle.at");
        const r = toNumber(c?.r ?? c?.radius);
        if (!Number.isFinite(r) || r <= 0) fail("circle needs a positive r");
        return { at, r, dash: Boolean(c?.dash) };
    });
    const vectors = asArray(spec.vectors).map((item) => {
        const v = item as Spec;
        return {
            a: resolve(v?.from ?? [0, 0], pts, "vector.from"),
            b: resolve(v?.to, pts, "vector.to"),
            label: str(v?.label),
        };
    });
    const angles = asArray(spec.angles).map((item) => {
        const a = item as Spec;
        return {
            at: resolve(a?.at ?? a?.vertex, pts, "angle.at"),
            from: resolve(a?.from, pts, "angle.from"),
            to: resolve(a?.to, pts, "angle.to"),
            label: str(a?.label),
            right: Boolean(a?.right),
        };
    });
    const labels = asArray(spec.labels).map((item) => {
        const l = item as Spec;
        return {
            at: resolve(l?.at, pts, "label.at"),
            text: str(l?.text ?? l?.label),
            place: str(l?.place),
        };
    });

    if (!pts.size && !circles.length && !edges.length && !vectors.length) {
        fail("the figure is empty");
    }

    // Fit to everything that will be drawn, circles included by their extent.
    const xs: number[] = [];
    const ys: number[] = [];
    const note = (p: Pt) => {
        xs.push(p[0]);
        ys.push(p[1]);
    };
    pts.forEach(note);
    for (const e of edges) {
        note(e.a);
        note(e.b);
    }
    for (const v of vectors) {
        note(v.a);
        note(v.b);
    }
    for (const l of labels) note(l.at);
    for (const ci of circles) {
        xs.push(ci.at[0] - ci.r, ci.at[0] + ci.r);
        ys.push(ci.at[1] - ci.r, ci.at[1] + ci.r);
    }
    if (!xs.length) fail("the figure has no coordinates");

    let x0 = Math.min(...xs);
    let x1 = Math.max(...xs);
    let y0 = Math.min(...ys);
    let y1 = Math.max(...ys);
    if (x1 - x0 < 1e-9) {
        x0 -= 1;
        x1 += 1;
    }
    if (y1 - y0 < 1e-9) {
        y0 -= 1;
        y1 += 1;
    }
    checkWindow(x0, x1, y0, y1);

    // Generous padding: vertex names sit 15px outside the geometry's bounding box
    // and need their own height on top of that. A clipped label is a figure
    // nobody can talk about — "find angle ACB" with no C on it.
    const pad = { l: 34, r: 34, t: 26, b: 30 };
    const box = equalBox(
        x1 - x0,
        y1 - y0,
        pad,
        spec.height === undefined ? VIZ_H_MAX : clampHeight(spec.height),
    );
    const c = new Canvas(box.w, box.h, pad);
    c.fit(x0, x1, y0, y1, true);

    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const diag = Math.hypot(x1 - x0, y1 - y0) || 1;

    for (const ci of circles) {
        c.circle(c.x(ci.at[0]), c.y(ci.at[1]), ci.r * c.scaleX, {
            dash: ci.dash ? "8 5" : undefined,
        });
    }

    for (const e of edges) {
        const ax = c.x(e.a[0]);
        const ay = c.y(e.a[1]);
        const bx = c.x(e.b[0]);
        const by = c.y(e.b[1]);
        c.line(ax, ay, bx, by, { dash: e.dash ? "8 5" : undefined });

        if (e.marks) {
            // Congruence ticks: short strokes across the midpoint, which is how
            // a diagram says "these two sides are equal" without words.
            const mx = (ax + bx) / 2;
            const my = (ay + by) / 2;
            const len = Math.hypot(bx - ax, by - ay) || 1;
            const ux = (bx - ax) / len;
            const uy = (by - ay) / len;
            for (let k = 0; k < e.marks; k++) {
                const off = (k - (e.marks - 1) / 2) * 6;
                const px = mx + ux * off;
                const py = my + uy * off;
                c.line(px - uy * 6, py + ux * 6, px + uy * 6, py - ux * 6, { width: STROKE.mark });
            }
        }
        if (e.label) {
            const mx = (ax + bx) / 2;
            const my = (ay + by) / 2;
            const len = Math.hypot(bx - ax, by - ay) || 1;
            // Push the length label to the outward side of the edge.
            const nx = -(by - ay) / len;
            const ny = (bx - ax) / len;
            const outward = (mx - c.x(cx)) * nx + (my - c.y(cy)) * ny >= 0 ? 1 : -1;
            c.text(mx + nx * outward * 13, my + ny * outward * 13, e.label, {
                anchor: "middle",
                size: FONT_PX.tick,
            });
        }
    }

    for (const v of vectors) {
        c.arrow(c.x(v.a[0]), c.y(v.a[1]), c.x(v.b[0]), c.y(v.b[1]));
        if (v.label) {
            const mx = (c.x(v.a[0]) + c.x(v.b[0])) / 2;
            const my = (c.y(v.a[1]) + c.y(v.b[1])) / 2;
            c.text(mx + 8, my - 8, v.label, { bold: true });
        }
    }

    for (const a of angles) {
        const vx = c.x(a.at[0]);
        const vy = c.y(a.at[1]);
        const a0 = Math.atan2(c.y(a.from[1]) - vy, c.x(a.from[0]) - vx);
        const a1 = Math.atan2(c.y(a.to[1]) - vy, c.x(a.to[0]) - vx);
        if (a.right) {
            const r = 13;
            const p1x = vx + r * Math.cos(a0);
            const p1y = vy + r * Math.sin(a0);
            const p2x = vx + r * Math.cos(a1);
            const p2y = vy + r * Math.sin(a1);
            c.polyline(
                [
                    [p1x, p1y],
                    [p1x + p2x - vx, p1y + p2y - vy],
                    [p2x, p2y],
                ],
                { width: STROKE.mark },
            );
            continue;
        }
        c.arc(vx, vy, 19, a0, a1, { width: STROKE.mark });
        if (a.label) {
            let mid = (a0 + a1) / 2;
            // The bisector of the *shorter* sweep; the other one points away
            // from the angle being marked.
            if (Math.abs(a1 - a0) > Math.PI) mid += Math.PI;
            c.text(vx + 32 * Math.cos(mid), vy + 32 * Math.sin(mid), a.label, {
                anchor: "middle",
                size: FONT_PX.tick,
            });
        }
    }

    const placed = new Set(labels.filter((l) => l.text).map((l) => `${l.at[0]},${l.at[1]}`));
    if (spec.showPoints !== false) {
        pts.forEach((p, name) => {
            c.dot(c.x(p[0]), c.y(p[1]), 4);
            if (!name || placed.has(`${p[0]},${p[1]}`) || spec.showLabels === false) return;
            // Away from the figure's middle, so a vertex name never lands on top
            // of the edges meeting there. A point that *is* the middle — the
            // centre of a circle — has no outward direction, and left the label
            // sitting invisibly on its own marker; those go down-left.
            let dx = p[0] - cx;
            let dy = p[1] - cy;
            let len = Math.hypot(dx, dy);
            if (len < diag * 0.04) {
                dx = -1;
                dy = -1;
                len = Math.SQRT2;
            }
            const ox = (dx / len) * 15;
            const oy = -(dy / len) * 15;
            c.text(c.x(p[0]) + ox, c.y(p[1]) + oy, name, {
                anchor: ox > 4 ? "start" : ox < -4 ? "end" : "middle",
                baseline: oy > 4 ? "top" : oy < -4 ? "bottom" : "middle",
                bold: true,
            });
        });
    }

    for (const l of labels) {
        if (!l.text) continue;
        const place = l.place || "above";
        const ox = place.includes("left") ? -14 : place.includes("right") ? 14 : 0;
        const oy = place.includes("below") ? 14 : place.includes("above") ? -14 : 0;
        c.text(c.x(l.at[0]) + ox, c.y(l.at[1]) + oy, l.text, {
            anchor: ox > 0 ? "start" : ox < 0 ? "end" : "middle",
            baseline: oy > 0 ? "top" : oy < 0 ? "bottom" : "middle",
            bold: true,
        });
    }

    return c.render();
}

// ── bars ────────────────────────────────────────────────────────────────────

const MAX_BARS = 7;

export function renderBars(spec: Spec): string {
    const raw = spec.items ?? spec.data ?? spec.bars;
    const items: Array<{ label: string; value: number }> = [];
    if (Array.isArray(raw)) {
        for (const item of raw) {
            const b = item as Spec;
            const value = toNumber(b?.value ?? (Array.isArray(item) ? item[1] : undefined));
            const label = str(b?.label ?? (Array.isArray(item) ? item[0] : ""));
            if (!Number.isFinite(value)) fail("a bar has no numeric value");
            items.push({ label, value });
        }
    } else if (raw && typeof raw === "object") {
        for (const [label, value] of Object.entries(raw as Record<string, unknown>)) {
            const v = toNumber(value);
            if (!Number.isFinite(v)) fail(`bar "${label}" has no numeric value`);
            items.push({ label, value: v });
        }
    }
    if (!items.length) fail("no bars");
    if (items.length > MAX_BARS) fail(`${items.length} bars is more than this screen can label`);

    // Horizontal: category names are words, and words fit along 544px far
    // better than under a 60px-wide column.
    const rowH = 26;
    const gap = 8;
    const height = Math.max(
        VIZ_H_MIN,
        Math.min(VIZ_H_MAX, items.length * rowH + (items.length - 1) * gap + 16),
    );
    const c = new Canvas(VIZ_W, height, { l: 4, r: 4, t: 8, b: 8 });

    const labelW = Math.min(150, Math.max(...items.map((i) => i.label.length)) * 8 + 10);
    const valueW = 54;
    const trackX = c.left + labelW + 8;
    const trackW = Math.max(40, c.right - valueW - trackX);
    const lo = Math.min(0, ...items.map((i) => i.value));
    const hi = Math.max(0, ...items.map((i) => i.value));
    const span = hi - lo || 1;
    const zeroX = trackX + ((0 - lo) / span) * trackW;

    // Thin marks: a full-height bar of solid white is a slab of glare on a panel
    // this bright, and the length is the data — the thickness carries nothing.
    const barH = 14;
    items.forEach((item, i) => {
        const top = c.top + i * (rowH + gap);
        const mid = top + rowH / 2;
        const barTop = mid - barH / 2;
        c.text(c.left + labelW, mid, item.label, { anchor: "end", size: FONT_PX.label });
        const end = trackX + ((item.value - lo) / span) * trackW;
        const x = Math.min(zeroX, end);
        const w = Math.abs(end - zeroX);
        // Rounded at the data end, square against the baseline.
        c.rect(x, barTop, Math.max(2, w), barH, INK.data, 4);
        if (w > 6) c.rect(item.value >= 0 ? x : x + w - 4, barTop, 4, barH, INK.data);
        c.text(end + (item.value >= 0 ? 8 : -8), mid, fmtNumber(item.value) + str(spec.unit), {
            anchor: item.value >= 0 ? "start" : "end",
            size: FONT_PX.label,
            bold: true,
        });
    });

    if (lo < 0) c.line(zeroX, c.top, zeroX, c.bottom, { stroke: INK.guide, width: STROKE.guide });

    return c.render();
}

// ── number line ─────────────────────────────────────────────────────────────

/** `-inf`, `∞`, `+infinity` — an unbounded end, drawn as an arrow off the frame. */
function infinite(value: unknown): number {
    const s = String(value ?? "").toLowerCase().replace(/\s/g, "");
    if (/^[+]?(inf|infty|infinity|∞|\\infty)$/.test(s)) return 1;
    if (/^-(inf|infty|infinity|∞|\\infty)$/.test(s)) return -1;
    return 0;
}

export function renderNumberLine(spec: Spec): string {
    const marks = asArray(spec.points).map((p) => {
        const item = p as Spec;
        const at = toNumber(item?.at ?? p);
        if (!Number.isFinite(at)) fail("a marked point is not a number");
        return { at, label: str(item?.label), open: Boolean(item?.open) };
    });
    const intervals = asArray(spec.intervals).map((iv) => {
        const item = iv as Spec;
        const pair = Array.isArray(iv) ? iv : [item?.from, item?.to];
        const fromInf = infinite(pair[0]);
        const toInf = infinite(pair[1]);
        const from = fromInf ? NaN : toNumber(pair[0]);
        const to = toInf ? NaN : toNumber(pair[1]);
        if (!fromInf && !Number.isFinite(from)) fail("an interval start is not a number");
        if (!toInf && !Number.isFinite(to)) fail("an interval end is not a number");
        return {
            from,
            to,
            fromInf,
            toInf,
            openFrom: Boolean(item?.openFrom ?? item?.open),
            openTo: Boolean(item?.openTo ?? item?.open),
            label: str(item?.label),
        };
    });
    if (!marks.length && !intervals.length) fail("nothing on the line");

    const finite: number[] = marks.map((m) => m.at);
    for (const iv of intervals) {
        if (!iv.fromInf) finite.push(iv.from);
        if (!iv.toInf) finite.push(iv.to);
    }
    let x0: number;
    let x1: number;
    if (spec.x !== undefined) {
        [x0, x1] = asRange(spec.x, "x");
    } else {
        const lo = Math.min(...finite);
        const hi = Math.max(...finite);
        const pad = (hi - lo || 2) * 0.28;
        x0 = lo - pad;
        x1 = hi + pad;
    }

    // Row assignment happens here, in data units, because it decides how tall the
    // canvas has to be — and the canvas is what would give us pixels.
    const labelRoom = (x1 - x0) * 0.06;
    const rowEnds: number[] = [];
    const rowOf = intervals.map((iv) => {
        const from = iv.fromInf ? x0 : iv.from;
        const to = iv.toInf ? x1 : iv.to;
        let row = 0;
        while (rowEnds[row] !== undefined && rowEnds[row]! > from - labelRoom) row++;
        rowEnds[row] = to;
        return row;
    });

    const hasLabels = intervals.some((iv) => iv.label) || marks.some((m) => m.label);
    const stacked = Math.max(1, rowEnds.length);
    const height = clampHeight(
        spec.height ?? 30 + 16 + (stacked - 1) * 20 + (hasLabels ? 26 : 10),
    );
    const c = new Canvas(VIZ_W, height, { l: 22, r: 22, t: 14, b: 30 });
    c.fit(x0, x1, 0, 1);

    const lineY = c.bottom;
    c.arrow(c.left, lineY, c.right, lineY, { stroke: INK.guide, width: STROKE.guide, head: 9 });
    c.arrow(c.right, lineY, c.left, lineY, { stroke: INK.guide, width: STROKE.guide, head: 9 });

    const step = toNumber(spec.step) > 0 ? toNumber(spec.step) : chooseStep(x1 - x0, c.innerW, 46, 12);
    for (const t of ticksIn(x0, x1, step)) {
        const px = c.x(t);
        c.line(px, lineY - 5, px, lineY + 5, { stroke: INK.guide, width: STROKE.guide });
        c.text(px, lineY + 8, fmtNumber(t), {
            anchor: "middle",
            baseline: "top",
            size: FONT_PX.tick,
            fill: INK.guide,
        });
    }

    // Disjoint intervals share a row: a union like (-∞;-2] ∪ [2;+∞) is two pieces
    // of one answer, and putting them on separate rows reads as two answers.
    intervals.forEach((iv, i) => {
        const ax = iv.fromInf ? c.left : c.x(iv.from);
        const bx = iv.toInf ? c.right : c.x(iv.to);
        const y = lineY - 16 - rowOf[i]! * 20;
        if (iv.fromInf) c.arrow(ax + 12, y, c.left, y, { width: STROKE.data, head: 10 });
        if (iv.toInf) c.arrow(bx - 12, y, c.right, y, { width: STROKE.data, head: 10 });
        c.line(iv.fromInf ? c.left + 4 : ax, y, iv.toInf ? c.right - 4 : bx, y, { width: 3.5, cap: "butt" });
        if (!iv.fromInf) c.dot(ax, y, 5, iv.openFrom);
        if (!iv.toInf) c.dot(bx, y, 5, iv.openTo);
        if (iv.label) c.text((ax + bx) / 2, y - 11, iv.label, { anchor: "middle", baseline: "bottom", bold: true });
    });

    for (const m of marks) {
        if (m.at < x0 || m.at > x1) continue;
        c.dot(c.x(m.at), lineY, 5.5, m.open);
        if (m.label) c.text(c.x(m.at), lineY - 12, m.label, { anchor: "middle", baseline: "bottom", bold: true });
    }

    return c.render();
}
