// Markdown -> paginated PNG tiles, rendered server-side.
//
// This is the heavy lifting that used to run in the glasses webview (marked +
// MathJax + html2canvas). Here a headless Chromium lays out the exact same
// HTML+CSS (so the on-glass result is unchanged) into one tall bitmap, and
// sharp slices it into the 2×2 grid of 288×128 tiles the client pushes over
// BLE. Tiles come back as base64 PNGs, greyscale + palette-reduced so the
// payload the client forwards stays small.

import { chromium, type Browser } from "playwright";
import sharp from "sharp";
import { RENDER_CSS, RENDER_WIDTH } from "./styles";
import { PAGE_H, PAGE_OVERLAP, TILE_H, TILES_X, TILES_Y, TILE_W } from "./constants";
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

// Slice the tall screenshot into pages of four tiles. Regions past the document
// end are padded with black so every tile is a full 288×128.
async function slice(png: Buffer): Promise<TilePage[]> {
    const meta = await sharp(png).metadata();
    const imgW = meta.width ?? RENDER_WIDTH;
    const imgH = meta.height ?? 0;

    const blackTile = (
        await sharp({
            create: { width: TILE_W, height: TILE_H, channels: 3, background: "#000" },
        })
            .grayscale()
            .png({ compressionLevel: 9, palette: true, colours: 16 })
            .toBuffer()
    ).toString("base64");

    // Each page advances by (PAGE_H - PAGE_OVERLAP) so consecutive pages share
    // PAGE_OVERLAP rows of context.
    const stride = Math.max(1, PAGE_H - PAGE_OVERLAP);
    const pageCount = imgH <= PAGE_H ? 1 : Math.ceil((imgH - PAGE_H) / stride) + 1;
    const pages: TilePage[] = [];

    for (let p = 0; p < pageCount; p++) {
        const pageTop = p * stride;
        const tiles: TileData[] = [];
        for (let ty = 0; ty < TILES_Y; ty++) {
            for (let tx = 0; tx < TILES_X; tx++) {
                const index = ty * TILES_X + tx;
                const sx = tx * TILE_W;
                const sy = pageTop + ty * TILE_H;
                const availW = Math.min(TILE_W, imgW - sx);
                const availH = Math.min(TILE_H, imgH - sy);

                if (availW <= 0 || availH <= 0) {
                    tiles.push({ index, data: blackTile });
                    continue;
                }

                const region = await sharp(png)
                    .extract({ left: sx, top: sy, width: availW, height: availH })
                    .toBuffer();
                const tileBuf = await sharp({
                    create: { width: TILE_W, height: TILE_H, channels: 3, background: "#000" },
                })
                    .composite([{ input: region, left: 0, top: 0 }])
                    .grayscale()
                    .png({ compressionLevel: 9, palette: true, colours: 16 })
                    .toBuffer();
                tiles.push({ index, data: tileBuf.toString("base64") });
            }
        }
        pages.push({ tiles });
    }

    return pages;
}

export async function renderTiles(markdown: string): Promise<TilePage[]> {
    const html = await renderMarkdownToHtml(markdown);
    const png = await screenshot(html);
    return slice(png);
}
