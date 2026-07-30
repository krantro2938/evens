// Look at a document the way the glasses will.
//
//   bun run render/viz/preview.ts my-doc.md out/
//
// Writes one PNG per page — the four tiles reassembled in their grid, on a green
// backdrop so the panel's actual contrast is what you judge. A figure that reads
// fine in a browser at 100% can be illegible here, and this is the only way to
// find that out without putting it on someone's face.
//
// Not imported by the server; it exists so a change to a renderer can be checked
// before it ships.

import sharp from "sharp";
import { TILE_H, TILES_X, TILES_Y, TILE_W } from "../constants";
import { closeBrowser, renderTiles } from "../tiles";

const [file, outDir = "."] = process.argv.slice(2);
if (!file) {
    console.error("usage: bun run render/viz/preview.ts <file.md> [outdir]");
    process.exit(1);
}

const markdown = await Bun.file(file).text();
const started = Date.now();
const pages = await renderTiles(markdown);
console.log(`${pages.length} page(s) in ${Date.now() - started}ms`);

for (const [i, page] of pages.entries()) {
    const name = `${outDir}/page-${String(i + 1).padStart(2, "0")}.png`;
    await sharp({
        create: {
            width: TILE_W * TILES_X,
            height: TILE_H * TILES_Y,
            channels: 3,
            background: "#000000",
        },
    })
        .composite(
            page.tiles.map((t) => ({
                input: Buffer.from(t.data, "base64"),
                left: (t.index % TILES_X) * TILE_W,
                top: Math.floor(t.index / TILES_X) * TILE_H,
            })),
        )
        .png()
        .toFile(name);
    console.log(name);
}

await closeBrowser();
