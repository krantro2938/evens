// Figures: 250 KB colour JPEGs on the web, ~5 KB monochrome PNGs on the panel.
//
// Four transforms, in this order, and the order matters:
//
//   -trim        The GeoGebra exports are mostly white margin. Cropping first
//                means the resize budget is spent on the drawing rather than on
//                empty paper, and it is worth more than every other step.
//   -negate      The panel is light-on-dark and the whole render is white text
//                on black (see server/render/styles.ts). A figure left as
//                black-on-white arrives as a slab of lit pixels with a faint
//                graph in it — the brightest thing on the display, and the
//                hardest to read.
//   -resize      Bounded so the figure AND its caption fit one page. A figure
//                split across a page boundary is the one thing pagination
//                cannot fix.
//   -posterize   These are line drawings: four grey levels carry every one of
//                them, and the tile encoder is going to quantise to 16 anyway.
//
// Measured on three real figures: 250/80/121 KB in, 8.6/3.9/8.2 KB out.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { figurePath } from "./fetch";

/**
 * The box a figure has to fit in.
 *
 * The render root is 576px wide with 16px of padding, and a page is 252px tall.
 * Leaving ~60px for the caption and the block's margins puts the ceiling here —
 * anything taller pushes its own caption onto the next page.
 */
const MAX_W = 544;
const MAX_H = 190;

export const OUT_DIR = join(import.meta.dir, "..", "..", "content", "enc", "img");

/** What the packed figure is called: "m3-1.png" for maga3's "1.jpg". */
export const figureName = (no: number, src: string) =>
    `m${no}-${src.replace(/\.[a-z]+$/i, "").replace(/[^\w-]/g, "_")}.png`;

/**
 * Compress one figure, if it hasn't been already.
 *
 * Returns null when the source was never cached — a figure the site had stopped
 * serving by the time it was fetched. The caller drops the block rather than
 * emitting a broken image, because a missing figure is a gap in a page and a
 * broken one is a red X in the middle of it.
 */
export async function packFigure(no: number, src: string): Promise<string | null> {
    const from = figurePath(no, src);
    if (!existsSync(from)) return null;

    const name = figureName(no, src);
    const to = join(OUT_DIR, name);
    if (existsSync(to)) return name;

    await mkdir(dirname(to), { recursive: true });
    const proc = Bun.spawn(
        [
            "magick", from,
            "-trim", "+repage",
            "-colorspace", "Gray",
            "-negate",
            "-normalize",
            "-resize", `${MAX_W}x${MAX_H}>`,
            "-posterize", "4",
            "-strip",
            to,
        ],
        { stderr: "pipe" },
    );
    const code = await proc.exited;
    if (code !== 0) {
        console.warn(`  ! magick failed on ${from}: ${await new Response(proc.stderr).text()}`);
        return null;
    }
    return name;
}

/** The packed figure as a data URI, for embedding in the render's HTML. */
export async function figureDataUri(name: string): Promise<string> {
    const bytes = await readFile(join(OUT_DIR, name));
    return `data:image/png;base64,${bytes.toString("base64")}`;
}

/** Write a file, creating its directory. Shared by the pack writers. */
export async function writeOut(path: string, data: string | Buffer): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
}
