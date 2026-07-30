// Markdown -> paginated PNG tiles, rendered server-side.
//
// This is the heavy lifting that used to run in the glasses webview (marked +
// MathJax + html2canvas). Here a headless Chromium lays out the exact same
// HTML+CSS (so the on-glass result is unchanged) into one tall bitmap, and
// sharp slices it into the 2×2 grid of 288×128 tiles the client pushes over
// BLE. Tiles come back as base64 PNGs, greyscale + palette-reduced so the
// payload the client forwards stays small.

import { chromium, type Browser, type Page } from "playwright";
import sharp, { type OverlayOptions } from "sharp";
import { RENDER_CSS, RENDER_WIDTH } from "./styles";
import {
    HUD_BORDER,
    PAGE_H,
    PAGE_OVERLAP,
    TILE_H,
    TILES_X,
    TILES_Y,
    TILE_W,
    type Rect,
} from "./constants";
import { renderMarkdownToHtml } from "./markdown";

export interface TileData {
    /** Index 0..3, row-major: matches the client's AI_TILE_IDS ordering. */
    index: number;
    /** base64-encoded PNG. */
    data: string;
}

export interface TilePage {
    tiles: TileData[];
}

// One long-lived browser, launched lazily and reused across renders.
let browserPromise: Promise<Browser> | null = null;
function getBrowser(): Promise<Browser> {
    if (!browserPromise) {
        browserPromise = chromium.launch({ args: ["--no-sandbox"] });
    }
    return browserPromise;
}

export async function closeBrowser(): Promise<void> {
    if (browserPromise) {
        const b = await browserPromise;
        browserPromise = null;
        await b.close();
    }
}

function pageHtml(bodyHtml: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:#000;}
      ${RENDER_CSS}
    </style></head><body><div class="md-root">${bodyHtml}</div></body></html>`;
}

/**
 * Blocks a page boundary must not land inside.
 *
 * A line of prose survives being cut because consecutive pages share
 * PAGE_OVERLAP rows — anything shorter than the overlap is whole on *some* page
 * whatever its position. A figure or a display equation is taller than that, so
 * it has to be placed rather than merely rendered.
 */
const KEEP_TOGETHER = ".viz-block, .viz-error, .math-display";

/** Enough for a document full of figures; the guard is against a layout that
 * refuses to settle, not against long documents. */
const KEEP_TOGETHER_PASSES = 40;

/**
 * Nudge indivisible blocks off the page seams.
 *
 * Pages start every `stride` rows and show `PAGE_H` of them, so the windows a
 * block can sit whole inside are [p·stride, p·stride+PAGE_H) — which overlap by
 * PAGE_OVERLAP and therefore leave gaps for anything taller than that. For a
 * block that falls in a gap, insert a spacer that carries it to the next page's
 * first row.
 *
 * One block per pass, then re-measure: a spacer moves everything below it, so
 * the positions the next decision needs are only knowable after the reflow.
 * Each pass settles the topmost offender for good — nothing above it ever moves
 * again — so this terminates in at most one pass per block.
 */
async function keepTogether(page: Page): Promise<number> {
    let shims = 0;
    for (let pass = 0; pass < KEEP_TOGETHER_PASSES; pass++) {
        const moved = await page.evaluate(
            ({ selector, stride, pageH }) => {
                const root = document.querySelector(".md-root");
                if (!root) return false;
                const rootTop = root.getBoundingClientRect().top;

                for (const el of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
                    const box = el.getBoundingClientRect();
                    // Taller than a page: no placement helps, and shuffling it
                    // would only add blank rows before an unavoidable cut.
                    if (box.height > pageH) continue;
                    // Two spacers for one block means the reflow is fighting us;
                    // leave it where it is rather than push it down forever.
                    if (Number(el.dataset.vizShims ?? 0) >= 2) continue;

                    const top = box.top - rootTop;
                    const bottom = top + box.height;
                    const p = Math.max(0, Math.floor(top / stride));
                    if (bottom <= p * stride + pageH) continue;

                    const gap = (p + 1) * stride - top;
                    if (gap <= 0) continue;

                    // A spacer rather than a margin: margins collapse against
                    // the previous block's, so setting one shifts by an amount
                    // that depends on what came before.
                    const spacer = document.createElement("div");
                    spacer.style.cssText = `margin:0;padding:0;height:${gap}px`;
                    spacer.dataset.vizSpacer = "1";
                    el.parentNode?.insertBefore(spacer, el);
                    el.dataset.vizShims = String(Number(el.dataset.vizShims ?? 0) + 1);
                    return true;
                }
                return false;
            },
            { selector: KEEP_TOGETHER, stride: Math.max(1, PAGE_H - PAGE_OVERLAP), pageH: PAGE_H },
        );
        if (!moved) break;
        shims++;
        if (pass === KEEP_TOGETHER_PASSES - 1) {
            console.warn(`[tiles] keep-together hit its pass limit (${KEEP_TOGETHER_PASSES})`);
        }
    }

    // What could not be placed. The only legitimate cause is a block taller than
    // a page — the renderers clamp figures to prevent it, so this line firing
    // means a real one got through and someone is about to read half a diagram.
    const stuck = await page.evaluate(
        ({ selector, stride, pageH }) => {
            const root = document.querySelector(".md-root");
            if (!root) return [] as number[];
            const rootTop = root.getBoundingClientRect().top;
            return Array.from(root.querySelectorAll<HTMLElement>(selector))
                .map((el) => {
                    const box = el.getBoundingClientRect();
                    const top = box.top - rootTop;
                    const p = Math.max(0, Math.floor(top / stride));
                    return top + box.height <= p * stride + pageH ? 0 : Math.round(box.height);
                })
                .filter((h) => h > 0);
        },
        { selector: KEEP_TOGETHER, stride: Math.max(1, PAGE_H - PAGE_OVERLAP), pageH: PAGE_H },
    );
    if (stuck.length) {
        console.warn(`[tiles] ${stuck.length} block(s) still cross a page seam (heights: ${stuck.join(", ")}px; a page is ${PAGE_H}px)`);
    }

    return shims;
}

// Render the document HTML and screenshot the .md-root element (width fixed at
// RENDER_WIDTH by the CSS) into a single tall PNG.
async function screenshot(bodyHtml: string): Promise<Buffer> {
    const browser = await getBrowser();
    const page = await browser.newPage({
        viewport: { width: RENDER_WIDTH, height: 800 },
        deviceScaleFactor: 1,
    });
    try {
        await page.setContent(pageHtml(bodyHtml), { waitUntil: "load" });
        await page.evaluate(() => (document as unknown as { fonts?: { ready: Promise<unknown> } }).fonts?.ready);
        const shims = await keepTogether(page);
        if (shims) console.log(`[tiles] moved ${shims} block(s) off a page seam`);
        const el = await page.$(".md-root");
        return el
            ? await el.screenshot({ type: "png" })
            : await page.screenshot({ type: "png", fullPage: true });
    } finally {
        await page.close();
    }
}

/**
 * A page-sized RGBA layer: transparent everywhere except the reserved regions,
 * which are opaque black with a bright frame.
 *
 * Built once per render at page scale rather than per tile, so a region that
 * straddles a tile boundary needs no special handling — each tile just takes
 * its own crop of this.
 */
export function reservedLayer(rects: readonly Rect[]): Buffer {
    const width = TILE_W * TILES_X;
    const layer = Buffer.alloc(width * PAGE_H * 4, 0); // transparent

    const put = (x: number, y: number, value: number) => {
        if (x < 0 || y < 0 || x >= width || y >= PAGE_H) return;
        const i = (y * width + x) * 4;
        layer[i] = layer[i + 1] = layer[i + 2] = value;
        layer[i + 3] = 0xff; // opaque
    };

    for (const r of rects) {
        for (let y = r.y; y < r.y + r.h; y++) {
            for (let x = r.x; x < r.x + r.w; x++) {
                const onBorder =
                    x < r.x + HUD_BORDER ||
                    x >= r.x + r.w - HUD_BORDER ||
                    y < r.y + HUD_BORDER ||
                    y >= r.y + r.h - HUD_BORDER;
                put(x, y, onBorder ? 0xff : 0x00);
            }
        }
    }
    return layer;
}

// Slice the tall screenshot into pages of four tiles. Regions past the document
// end are padded with black so every tile is a full 288×128.
async function slice(png: Buffer, reserved: readonly Rect[] = []): Promise<TilePage[]> {
    const meta = await sharp(png).metadata();
    const imgW = meta.width ?? RENDER_WIDTH;
    const imgH = meta.height ?? 0;

    // Each page advances by (PAGE_H - PAGE_OVERLAP) so consecutive pages share
    // PAGE_OVERLAP rows of context.
    const stride = Math.max(1, PAGE_H - PAGE_OVERLAP);
    const pageCount = imgH <= PAGE_H ? 1 : Math.ceil((imgH - PAGE_H) / stride) + 1;
    const pages: TilePage[] = [];

    // Same on every page and every tile position, so build it once and crop.
    const layer = reserved.length ? reservedLayer(reserved) : null;

    for (let p = 0; p < pageCount; p++) {
        pages.push({ tiles: await cutTiles(png, p * stride, imgW, imgH, layer) });
    }

    return pages;
}

/**
 * One page's worth of tiles, cut from `png` starting at row `top`.
 *
 * Split out of slice() so a source that isn't a paginated document — the camera
 * preview (see camera.ts) — lands on the glasses through exactly the same
 * geometry and the same encoder. Anything past the edge of the image is padded
 * with black, so a short or narrow source still yields four full tiles.
 */
async function cutTiles(
    png: Buffer,
    top: number,
    imgW: number,
    imgH: number,
    layer: Buffer | null,
): Promise<TileData[]> {
    const pageW = TILE_W * TILES_X;
    const tiles: TileData[] = [];

    for (let ty = 0; ty < TILES_Y; ty++) {
        for (let tx = 0; tx < TILES_X; tx++) {
            const index = ty * TILES_X + tx;
            const sx = tx * TILE_W;
            const sy = top + ty * TILE_H;
            const availW = Math.min(TILE_W, imgW - sx);
            const availH = Math.min(TILE_H, imgH - sy);

            const layers: OverlayOptions[] = [];

            // Past the end of the document this stays empty and the tile is
            // just the black background.
            if (availW > 0 && availH > 0) {
                layers.push({
                    input: await sharp(png)
                        .extract({ left: sx, top: sy, width: availW, height: availH })
                        .toBuffer(),
                    left: 0,
                    top: 0,
                });
            }

            // The reserved panel backgrounds go on last, over the document —
            // covering it is the entire point.
            if (layer) {
                const crop = Buffer.alloc(TILE_W * TILE_H * 4);
                for (let y = 0; y < TILE_H; y++) {
                    const from = ((ty * TILE_H + y) * pageW + tx * TILE_W) * 4;
                    layer.copy(crop, y * TILE_W * 4, from, from + TILE_W * 4);
                }
                layers.push({
                    input: crop,
                    raw: { width: TILE_W, height: TILE_H, channels: 4 },
                    left: 0,
                    top: 0,
                });
            }

            tiles.push({ index, data: (await encodeTile(layers)).toString("base64") });
        }
    }
    return tiles;
}

/**
 * The one place a tile becomes bytes. Greyscale and a small palette because
 * that is what the panel can show, and because the payload crosses BLE — see
 * the client's push instrumentation for what that costs.
 *
 * Documents keep all 16 greys: they are antialiased text, and the shades are
 * the edges of the letters. A photograph does not need them (see
 * PREVIEW_COLOURS in camera.ts), which is worth knowing because it is the
 * cheapest byte saving in this pipeline.
 */
export async function encodeTile(
    layers: OverlayOptions[],
    opts: { colours?: number; dither?: number } = {},
): Promise<Buffer> {
    return sharp({
        create: { width: TILE_W, height: TILE_H, channels: 3, background: "#000" },
    })
        .composite(layers)
        .grayscale()
        .png({
            compressionLevel: 9,
            palette: true,
            colours: opts.colours ?? 16,
            // Dithering trades a speckle for a smoother gradient. Text wants
            // it; a photograph reduced to a handful of greys does not — there
            // the speckle IS the noise, and it costs bytes to send.
            ...(opts.dither === undefined ? {} : { dither: opts.dither }),
        })
        .toBuffer();
}

export interface RenderOptions {
    /**
     * Regions the glasses keep a permanent text panel over. Painted dark with a
     * frame so the panel's text is legible — see the note at HUD_FEEDBACK for
     * why this can't be done on the device.
     */
    reserved?: readonly Rect[];
}

export async function renderTiles(
    markdown: string,
    opts: RenderOptions = {},
): Promise<TilePage[]> {
    const html = await renderMarkdownToHtml(markdown);
    const png = await screenshot(html);
    return slice(png, opts.reserved ?? []);
}
