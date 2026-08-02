// HTML -> paginated PNG tiles for the glasses.
//
// We render the whole document once into a hidden offscreen node at the panel
// width, rasterize it to one tall canvas with html2canvas, then slice that
// canvas into 256px-tall pages, each cut into a 2x2 grid of 288x128 tiles.

import html2canvas from "html2canvas";
import { PAGE_H, TILE_H, TILES_X, TILES_Y, TILE_W } from "../constants";
import { RENDER_CSS, RENDER_WIDTH } from "./styles";

export interface Tile {
    index: number;
    x: number;
    y: number;
    width: number;
    height: number;
    bytes: Uint8Array;
}

export interface TilePage {
    tiles: Tile[];
}

let styleInjected = false;
function ensureStyle(): void {
    if (styleInjected) return;
    const el = document.createElement("style");
    el.setAttribute("data-md-render", "");
    el.textContent = RENDER_CSS;
    document.head.appendChild(el);
    styleInjected = true;
}

function tileToPng(source: HTMLCanvasElement, sx: number, sy: number): Promise<Uint8Array> {
    const canvas = document.createElement("canvas");
    canvas.width = TILE_W;
    canvas.height = TILE_H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, TILE_W, TILE_H);

    const availW = Math.min(TILE_W, source.width - sx);
    const availH = Math.min(TILE_H, source.height - sy);
    if (availW > 0 && availH > 0) {
        ctx.drawImage(source, sx, sy, availW, availH, 0, 0, availW, availH);
    }

    return new Promise((resolve, reject) => {
        canvas.toBlob(async (blob) => {
            if (!blob) return reject(new Error("tile toBlob failed"));
            resolve(new Uint8Array(await blob.arrayBuffer()));
        }, "image/png");
    });
}

export async function renderToPages(html: string): Promise<TilePage[]> {
    ensureStyle();

    const root = document.createElement("div");
    root.className = "md-root";
    root.innerHTML = html;
    root.style.position = "fixed";
    root.style.left = "-10000px";
    root.style.top = "0";
    document.body.appendChild(root);

    try {
        if (document.fonts?.ready) await document.fonts.ready;

        const source = await html2canvas(root, {
            backgroundColor: "#000",
            width: RENDER_WIDTH,
            windowWidth: RENDER_WIDTH,
            scale: 1,
            logging: false,
        });

        const pageCount = Math.max(1, Math.ceil(source.height / PAGE_H));
        const pages: TilePage[] = [];

        for (let p = 0; p < pageCount; p++) {
            const tiles: Tile[] = [];
            for (let ty = 0; ty < TILES_Y; ty++) {
                for (let tx = 0; tx < TILES_X; tx++) {
                    const index = ty * TILES_X + tx;
                    const sx = tx * TILE_W;
                    const sy = p * PAGE_H + ty * TILE_H;
                    const bytes = await tileToPng(source, sx, sy);
                    tiles.push({
                        index,
                        x: tx * TILE_W,
                        y: ty * TILE_H,
                        width: TILE_W,
                        height: TILE_H,
                        bytes,
                    });
                }
            }
            pages.push({ tiles });
        }

        return pages;
    } finally {
        root.remove();
    }
}
