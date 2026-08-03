// The assignment as pictures — for a screen you can actually read, and for a
// file you can keep.
//
// Everything else in this directory renders for the glasses: 288×126 tiles,
// four to a page, greyscale, palette-reduced, base64'd into JSON because they
// cross BLE. That is the right shape for a HUD and the wrong shape for every
// other question you might have about the sheet in front of the camera — "is
// the transcription any good", "let me read this on the laptop", "save it".
//
// So this renders the same document, through the same markdown pipeline and the
// same CSS, into two things:
//
//   pages   576×252 PNGs, one per page, with the same stride and the same
//           PAGE_OVERLAP rows of shared context the glasses page through.
//           These ARE what the glasses show, minus the 2×2 seam — same layout,
//           same greys, same breaks. Looking at them tells you what is on the
//           display right now.
//   full    the entire document, top to bottom, at SHEET_SCALE× the raster.
//           Nothing is cut, so nothing has to be paged; this is the download.
//
// The layout is IDENTICAL between the two — `scale` multiplies pixels, not CSS
// — so the download is not a differently-shaped document that happens to have
// the same words. It is the same render, uncut and sharper.

import sharp from "sharp";
import { renderDocumentImage } from "./tiles";
import { PAGE_H, PAGE_OVERLAP, TILE_W, TILES_X } from "./constants";
import type { DocSource } from "../doc";

/** The panel's full width: what a page image is, before it is cut into tiles. */
const SHEET_W = TILE_W * TILES_X;

/**
 * How much denser the downloadable render is than the glasses'.
 *
 * 576px wide is a HUD, not a document — legible on glass at arm's length and
 * unpleasantly soft as a PNG on a laptop. Two is enough to read comfortably and
 * to print; it costs one extra screenshot per version and no layout risk at all.
 */
const SHEET_SCALE = Math.max(1, Math.min(4, Number(process.env.SHEET_SCALE ?? 2)));

export interface SheetPage {
    /** 0-based, in reading order — the same page numbers the glasses count in. */
    index: number;
    png: Buffer;
}

export interface Sheet {
    /** The source document's version, which is also this render's cache key. */
    version: number;
    pages: SheetPage[];
    /** The whole document in one image. */
    full: Buffer;
    full_width: number;
    full_height: number;
    page_width: number;
    page_height: number;
    scale: number;
}

/**
 * Greyscale, 16 colours, exactly as encodeTile does it.
 *
 * The point of the page images is that they are what the glasses show, and the
 * palette is part of that: a full-colour render of the same layout would look
 * better and would be lying about the display.
 */
async function encodePage(input: Buffer, width: number, height: number): Promise<Buffer> {
    return sharp({
        create: { width, height, channels: 3, background: "#000" },
    })
        .composite([{ input, left: 0, top: 0 }])
        .grayscale()
        .png({ compressionLevel: 9, palette: true, colours: 16 })
        .toBuffer();
}

/**
 * Cut the tall render into page images.
 *
 * Same arithmetic as tiles.ts's slice(), and it has to be: a page here that
 * started one row from where the glasses' does would be a picture of a document
 * the glasses are not showing. Anything past the bottom of the last page is
 * padded with black, which is what the glasses do with it too.
 */
async function cutPages(png: Buffer): Promise<{ pages: SheetPage[]; height: number }> {
    const meta = await sharp(png).metadata();
    const imgW = meta.width ?? SHEET_W;
    const imgH = meta.height ?? 0;

    const stride = Math.max(1, PAGE_H - PAGE_OVERLAP);
    const count = imgH <= PAGE_H ? 1 : Math.ceil((imgH - PAGE_H) / stride) + 1;

    const pages: SheetPage[] = [];
    for (let i = 0; i < count; i++) {
        const top = i * stride;
        const availH = Math.min(PAGE_H, imgH - top);
        const availW = Math.min(SHEET_W, imgW);
        const crop =
            availH > 0 && availW > 0
                ? await sharp(png)
                      .extract({ left: 0, top, width: availW, height: availH })
                      .toBuffer()
                : await sharp({
                      create: { width: 1, height: 1, channels: 3, background: "#000" },
                  })
                      .png()
                      .toBuffer();
        pages.push({ index: i, png: await encodePage(crop, SHEET_W, PAGE_H) });
    }
    return { pages, height: imgH };
}

/**
 * Render one document to a sheet.
 *
 * Two screenshots rather than one downscaled: resampling the 2× raster to 576
 * would produce page images subtly unlike the tiles the glasses are showing,
 * and being able to trust that they match is the only reason the page view
 * exists. The cost is one extra Chromium pass per version, behind the cache
 * below, on a document that changes when a person photographs a new sheet.
 */
export async function renderSheet(markdown: string, version: number): Promise<Sheet> {
    const started = Date.now();
    // At SHEET_SCALE 1 the two renders are the same bytes, so don't take the
    // second one — the whole difference between them is the raster density.
    const panel = await renderDocumentImage(markdown, 1);
    const full = SHEET_SCALE === 1 ? panel : await renderDocumentImage(markdown, SHEET_SCALE);

    const { pages } = await cutPages(panel);
    const fullMeta = await sharp(full).metadata();

    console.log(
        `[sheet] rendered ${pages.length} page(s) + a ${fullMeta.width}×${fullMeta.height} ` +
            `full image in ${Date.now() - started}ms (v${version})`,
    );

    return {
        version,
        pages,
        full,
        full_width: fullMeta.width ?? SHEET_W * SHEET_SCALE,
        full_height: fullMeta.height ?? 0,
        page_width: SHEET_W,
        page_height: PAGE_H,
        scale: SHEET_SCALE,
    };
}

/**
 * A sheet cache over a document source, keyed by version — the same bargain
 * createTileCache makes, and for the same reason: this is seconds of headless
 * Chromium, and a page that shows six page images fetches each of them
 * separately. A burst renders once.
 */
export function createSheetCache(source: DocSource): () => Promise<Sheet> {
    let cache: Sheet | null = null;
    let inFlight: Promise<Sheet> | null = null;

    return async function getSheet(): Promise<Sheet> {
        const { content, version } = await source.read();
        if (cache?.version === version) return cache;
        if (inFlight) return inFlight;

        inFlight = (async () => {
            const sheet = await renderSheet(content, version);
            cache = sheet;
            return sheet;
        })();
        try {
            return await inFlight;
        } finally {
            inFlight = null;
        }
    };
}

export { SHEET_SCALE, SHEET_W };
