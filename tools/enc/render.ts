// The renderer, borrowed whole from the document server.
//
// `renderTiles` is what turns your solutions into what you read on the glasses:
// marked, MathJax to SVG, headless Chromium at 576px, sharp down to a 16-grey
// palette PNG per tile. Importing it rather than reimplementing it is the point
// — an encyclopedia rendered by a second pipeline would drift from every other
// document in the app, and would need its own answer to keep-together,
// quantisation and tile geometry.
//
// The difference is WHEN it runs. For a solution it runs on request, because
// the solution did not exist a moment ago. The encyclopedia is static, so it
// runs here, once, on a developer machine with a browser installed — and the
// phone in the exam room needs neither Chromium nor MathJax nor a network.

import { closeBrowser, renderTiles } from "../../server/render/tiles";
import type { Page } from "./paginate";

export { closeBrowser };

/**
 * One markdown chunk -> the pages of tiles it occupies.
 *
 * Chunks, not whole documents: the paginator hands over only the runs that
 * need rendering, so a node that is mostly prose costs a render of its two
 * formulas rather than of all six of its pages.
 */
export async function renderChunk(markdown: string): Promise<Page[]> {
    const rendered = await renderTiles(markdown);
    return rendered.map((page) => ({
        kind: "tiles" as const,
        // Row-major, and index-ordered explicitly: the client pushes
        // tiles[i] to DOC_TILE_IDS[i] and nothing downstream re-sorts them.
        tiles: [...page.tiles].sort((a, b) => a.index - b.index).map((t) => t.data),
    }));
}
