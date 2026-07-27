// Markdown -> paginated PNG tiles, rendered server-side.
//
// This is the heavy lifting that used to run in the glasses webview (marked +
// MathJax + html2canvas). Here a headless Chromium lays out the exact same
// HTML+CSS (so the on-glass result is unchanged) into one tall bitmap, and
// sharp slices it into the 2×2 grid of 288×128 tiles the client pushes over
// BLE. Tiles come back as base64 PNGs, greyscale + palette-reduced so the
// payload the client forwards stays small.

import { chromium, type Browser } from "playwright";
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
 * The one place a tile becomes bytes. Greyscale and a 16-colour palette because
 * that is what the panel can show, and because the payload crosses BLE — see
 * the client's push instrumentation for what that costs.
 */
export async function encodeTile(layers: OverlayOptions[]): Promise<Buffer> {
    return sharp({
        create: { width: TILE_W, height: TILE_H, channels: 3, background: "#000" },
    })
        .composite(layers)
        .grayscale()
        .png({ compressionLevel: 9, palette: true, colours: 16 })
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
