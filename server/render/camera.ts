// A camera frame, as tiles the glasses can show.
//
// The reader's advice enum ("move_down", "refocus") is the model's read on
// framing, and it is in the CAMERA's frame of reference — so it cannot express
// the one thing a hand-placed camera gets wrong most often, which is being
// rotated. `move_up` with the camera rolled 90° points you sideways. A picture
// says it in one glance, costs no API call, and is the whole reason this exists.
//
// Two sizes, because the payload is the constraint. These come out of the same
// encoder as the document tiles (greyscale, 16-colour palette PNG), and a
// photograph does not palette-compress the way black-background text does:
//
//   4 tiles, 576×252   ~32KB   the Camera page's default — the frame, big
//   1 tile,  288×126   ~8KB    when the link can't feed the big one
//
// For comparison a whole page of transcription is ~7KB, so the full-size
// preview is roughly 4.5 document page turns per refresh. The client paces
// itself off what a push actually took rather than a fixed interval; see
// camera.ts there.

import sharp, { type OverlayOptions } from "sharp";
import { encodeTile, reservedLayer, type TileData } from "./tiles";
import { PAGE_H, TILE_H, TILES_X, TILE_W, type Rect } from "./constants";

/** How much of the panel the preview fills. */
export type PreviewSize = 1 | 4;

export interface CameraTilesOptions {
    size?: PreviewSize;
    /** Degrees clockwise to turn the frame before it is fitted. */
    rotate?: number;
    /** Panel rects to bake a dark background into, as the document tiles do. */
    reserved?: readonly Rect[];
}

/** The rotations the preview offers. Anything else is refused, not rounded. */
export const ROTATIONS = [0, 90, 180, 270] as const;

const PAGE_W = TILE_W * TILES_X;

/** Thickness of the box drawn round the camera's field of view. */
const BORDER = 2;

/**
 * Fit the frame into `w`×`h` and draw a hairline box round it.
 *
 * CONTAIN, never cover. The question the preview answers is "what is outside
 * the frame" — a crop that filled the panel would answer it wrongly, and
 * confidently. The bars that come with it are why the border matters: without
 * one there is no way to tell the edge of the camera's view from dark desk
 * beyond it, and a sheet that runs off the side looks the same as one that
 * doesn't.
 */
async function fitted(jpeg: Buffer, w: number, h: number, rotate: number): Promise<Buffer> {
    const frame = await sharp(jpeg)
        .rotate(rotate) // 0 is a no-op; sharp also auto-orients off EXIF at 0
        .resize(w, h, { fit: "contain", background: "#000" })
        .greyscale()
        // 16 levels of grey on a small panel: without this a dim room renders
        // as a uniform smudge and the sheet's edges — the entire signal — go
        // with it.
        .normalise()
        .toBuffer();

    const meta = await sharp(jpeg).rotate(rotate).metadata();
    const srcW = meta.width ?? w;
    const srcH = meta.height ?? h;
    const scale = Math.min(w / srcW, h / srcH);
    const drawnW = Math.round(srcW * scale);
    const drawnH = Math.round(srcH * scale);
    const left = Math.floor((w - drawnW) / 2);
    const top = Math.floor((h - drawnH) / 2);

    // A white rectangle on the letterboxed image's own edge. Two pixels, not
    // one: a hairline is what the panel's dithering loses first, and this line
    // is the difference between "the sheet runs off the side" and "the sheet
    // ends there".
    const border = Buffer.alloc(drawnW * drawnH * 4, 0);
    const put = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= drawnW || y >= drawnH) return;
        const i = (y * drawnW + x) * 4;
        border[i] = border[i + 1] = border[i + 2] = 0xff;
        border[i + 3] = 0xff;
    };
    for (let t = 0; t < BORDER; t++) {
        for (let x = 0; x < drawnW; x++) {
            put(x, t);
            put(x, drawnH - 1 - t);
        }
        for (let y = 0; y < drawnH; y++) {
            put(t, y);
            put(drawnW - 1 - t, y);
        }
    }

    return sharp(frame)
        .composite([
            { input: border, raw: { width: drawnW, height: drawnH, channels: 4 }, left, top },
        ])
        .png()
        .toBuffer();
}

/**
 * One camera frame as tiles, indexed the way the client's containers are
 * (row-major from the top left). A 1-tile preview returns index 0 alone; the
 * client leaves the other three containers empty, which is black.
 */
export async function renderCameraTiles(
    jpeg: Buffer,
    opts: CameraTilesOptions = {},
): Promise<TileData[]> {
    const size = opts.size ?? 4;
    const rotate = opts.rotate ?? 0;

    if (size === 1) {
        const png = await fitted(jpeg, TILE_W, TILE_H, rotate);
        const data = await encodeTile([{ input: png, left: 0, top: 0 }]);
        return [{ index: 0, data: data.toString("base64") }];
    }

    const png = await fitted(jpeg, PAGE_W, PAGE_H, rotate);
    // The advice panel is a transparent text container on the client, so its
    // background has to be baked in here — exactly as the document tiles do it.
    const layer = opts.reserved?.length ? reservedLayer(opts.reserved) : null;
    const tiles: TileData[] = [];

    for (let index = 0; index < 4; index++) {
        const tx = index % TILES_X;
        const ty = Math.floor(index / TILES_X);
        const layers: OverlayOptions[] = [
            {
                input: await sharp(png)
                    .extract({
                        left: tx * TILE_W,
                        top: ty * TILE_H,
                        width: TILE_W,
                        height: TILE_H,
                    })
                    .toBuffer(),
                left: 0,
                top: 0,
            },
        ];

        if (layer) {
            const crop = Buffer.alloc(TILE_W * TILE_H * 4);
            for (let y = 0; y < TILE_H; y++) {
                const from = ((ty * TILE_H + y) * PAGE_W + tx * TILE_W) * 4;
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

    return tiles;
}
