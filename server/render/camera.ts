// A camera frame, as tiles the glasses can show.
//
// The reader's advice enum ("move_down", "refocus") is the model's read on
// framing, and it is in the CAMERA's frame of reference — so it cannot express
// the one thing a hand-placed camera gets wrong most often, which is being
// rotated. `move_up` with the camera rolled 90° points you sideways. A picture
// says it in one glance, costs no API call, and is the whole reason this exists.
//
// Two sizes, because the payload is the constraint:
//
//   4 tiles, 576×252   ~13KB   the Camera page's default — the frame, big
//   1 tile,  288×126   ~4KB    when the link can't feed the big one
//
// A whole page of transcription is ~7KB, so a full-size preview is about two
// document page turns. The client paces itself off what a push actually took
// rather than a fixed interval; see camera.ts there.
//
// Everything below the letterbox — local contrast, the brightness target, the
// palette — was chosen by rendering real frames off THIS camera and looking at
// them on a green background, because that is what the panel is. Photographic
// judgement on a white screen gets it wrong in both directions.
//
// TWO MODES, AND WHY THE DEFAULT CHANGED. A sheet of paper is mostly paper, and
// a greyscale photograph of one is mostly light pixels — which on an emissive
// panel means most of the panel is LIT. That is the wall of green: the picture
// was not too bright in the photographic sense (its mean was pinned at 80), it
// was bright in the wrong PLACES, spending the panel's only signal on the part
// of the scene that carries no information. A blank or badly-exposed frame took
// it to the limit and lit the panel end to end.
//
// The document tiles never had this problem, because they are drawn the way the
// panel wants: black page, bright marks. `ink` renders the camera the same way.
// It subtracts the local background instead of equalising it, so what survives
// is what is DARKER than its surroundings — text, rules, the edge of the sheet
// against the desk — drawn bright on black. Everything the panel spent itself on
// before (paper, lighting gradient, glare) is gone, and it is not a loss: none
// of it was ever the thing you were looking for.
//
// `photo` is the old pipeline, kept behind a menu entry. It is the one to reach
// for when the question is about the SCENE rather than the page — where the
// camera is pointing in a dark room, whether a hand is in shot — which ink, by
// construction, throws away.

import sharp, { type OverlayOptions } from "sharp";
import { encodeTile, reservedLayer, type TileData } from "./tiles";
import { PAGE_H, TILE_H, TILES_X, TILE_W, type Rect } from "./constants";

/** How much of the panel the preview fills. */
export type PreviewSize = 1 | 4;

/** How a frame is turned into something the panel can show. See the note above. */
export type PreviewMode = "ink" | "photo";

/** The modes the preview offers. Anything else is refused, not defaulted. */
export const PREVIEW_MODES = ["ink", "photo"] as const;

export interface CameraTilesOptions {
    size?: PreviewSize;
    /** Degrees clockwise to turn the frame before it is fitted. */
    rotate?: number;
    mode?: PreviewMode;
    /** Panel rects to bake a dark background into, as the document tiles do. */
    reserved?: readonly Rect[];
}

export interface CameraPreview {
    tiles: TileData[];
    /**
     * How much ink the frame actually had, 0-255, before it was scaled up to
     * fill the panel — see INK_MIN_SPAN. Only ink mode measures it.
     *
     * This is the number that tells a dark panel apart from a broken one. An
     * ink render of a frame with nothing in it is BLACK, which is honest but
     * says the same thing as a preview that stopped arriving; the client puts
     * this in the footer so the two can't be confused.
     */
    contrast: number | null;
}

/** The rotations the preview offers. Anything else is refused, not rounded. */
export const ROTATIONS = [0, 90, 180, 270] as const;

const PAGE_W = TILE_W * TILES_X;

/** Thickness of the box drawn round the camera's field of view. */
const BORDER = 3;

// ── photo mode ──────────────────────────────────────────────────────────────

/**
 * Where the preview's average brightness is pinned, out of 255.
 *
 * The panel is emissive green, so it does not behave like a photo on a screen:
 * everything above roughly mid-grey reads as "on", and a picture whose average
 * sits high is a wall of green with the detail buried in it. CLAHE alone landed
 * at 121-133 depending on the scene, which is exactly that.
 *
 * Pinning the OUTPUT mean rather than darkening by a fixed amount is the point.
 * This camera's exposure swings between blown-out and nearly black from one
 * capture to the next, so a fixed offset that suits a bright room crushes a dim
 * one. Normalising afterwards makes the panel look the same either way, which
 * is what lets you learn to read it.
 *
 * It is also the ceiling on what this mode can do, and the reason ink exists:
 * a mean of 80 spread evenly over a sheet of paper is still most of the panel
 * lit, and no choice of number fixes that — the light is in the wrong place,
 * not merely too much of it.
 */
const TARGET_MEAN = 80;
/** Bounds on the correction, so a nearly-black frame is not amplified to noise. */
const MIN_GAIN = 0.35;
const MAX_GAIN = 2;

// Local-contrast settings, chosen by rendering real frames off the camera and
// looking at them (a small window is what makes text visible at all; a wide one
// washes back out). Slope caps how far flat areas can be amplified — without a
// cap, blank paper becomes a field of sensor noise, which is both ugly and, in
// PNG terms, expensive.
const CLAHE_WINDOW = 8;
const CLAHE_SLOPE = 3;

// ── ink mode ────────────────────────────────────────────────────────────────

/**
 * Radius of the local background, in OUTPUT pixels.
 *
 * The whole mode is one subtraction: blur the frame until the marks are gone
 * and only the lighting is left, then keep what the sharp copy is darker by.
 * That makes the radius the one setting that matters. Text on a sheet fitted to
 * this panel is 4-6px tall, so a blur of about that much erases the letters
 * while leaving the illumination — including a glare blob, which is why glare
 * simply stops being visible in this mode rather than eating a corner.
 *
 * Too small and the blur still contains the letters, which then cancel
 * themselves out; too large and it stops tracking the lighting and the mode
 * decays into a global threshold. Between about 4 and 8 the difference on real
 * frames is slight — this is the small end, which keeps thin strokes crispest.
 */
const INK_SIGMA = 4;

/**
 * Differences below this are sensor noise, not marks.
 *
 * A deadband rather than a subtraction: JPEG blocking off this camera is worth
 * two or three levels everywhere, and without a floor the normalisation below
 * happily scales that up into a full-panel speckle.
 */
const INK_FLOOR = 3;

/**
 * The smallest ink amplitude that gets normalised to full brightness.
 *
 * This is the guard that keeps the mode honest, and it is the direct answer to
 * a blank frame lighting the whole panel. Scaling ALWAYS to the frame's own
 * darkest marks means a frame with no marks in it — lens covered, hopelessly
 * out of focus, the washed-out grey this camera returns when it has lost
 * exposure — gets its own noise amplified to a confident-looking field of text
 * that is not there. Below this amplitude the frame is scaled as if it had
 * exactly this much ink, so a frame with nothing in it renders as nothing, and
 * `contrast` says why.
 */
const INK_MIN_SPAN = 16;

/**
 * Where the top of the ink scale is read from the histogram.
 *
 * Not the maximum: one speck of dust, one hair, one dead pixel is enough to be
 * the darkest thing in the frame, and scaling to it dims the actual text by
 * whatever that speck happened to be worth.
 */
const INK_PERCENTILE = 0.99;

/** Pulls mid-strength strokes up. Below 1 because thin text lands there. */
const INK_GAMMA = 0.8;

/** Window for the pre-blur despeckle. 3×3: enough for JPEG salt, cheap. */
const INK_DESPECKLE = 3;

/**
 * How the preview is encoded, and why it differs from the document's 16
 * dithered greys.
 *
 * Neither half is a compromise. At 8 greys the picture is indistinguishable by
 * eye from 16, and with dithering off the speckle goes with it — what CLAHE
 * amplifies in blank paper is sensor noise, and noise is what a palette encoder
 * spends its bytes on. Together they take a full panel from ~42KB to ~13KB,
 * which leaves the readable preview CHEAPER than the flat, unreadable one it
 * replaced (~30KB).
 *
 * Ink mode inherits both and goes much further for the same reason: a picture
 * that is mostly black with thin bright marks on it is nearly all one palette
 * entry, and a full panel of it lands around 4KB — a third of the photo it
 * replaced, on a link this page is already the heaviest user of.
 */
const PREVIEW_ENCODE = { colours: 8, dither: 0 } as const;

/** A greyscale frame at its drawn size, plus what ink mode measured in it. */
interface Pass {
    /** Raw single-channel pixels, `drawnW`×`drawnH`. */
    grey: Buffer;
    contrast: number | null;
}

/**
 * PHOTO: the frame equalised and dimmed — what the camera saw, made as legible
 * as a photograph on this panel can be.
 *
 * Downscale FIRST, then equalise. CLAHE's window is in output pixels, so
 * equalising at 1920×1080 would work below the size of a letter.
 */
async function photoPass(jpeg: Buffer, w: number, h: number, rotate: number): Promise<Pass> {
    const photo = await sharp(jpeg)
        .rotate(rotate) // 0 is a no-op; sharp also auto-orients off EXIF at 0
        .resize(w, h)
        .greyscale()
        // LOCAL contrast, not global. The camera's exposure swings between
        // washed-out and nearly black, and either way a global stretch does
        // nothing useful: one glare spot and one dark corner already put the
        // min and max at 0 and 255, leaving the page and its text squeezed into
        // a couple of levels — a flat blob on the panel. CLAHE equalises within
        // a small window instead, so text separates from paper whatever the
        // frame's overall exposure is doing.
        .clahe({ width: CLAHE_WINDOW, height: CLAHE_WINDOW, maxSlope: CLAHE_SLOPE })
        .toBuffer();

    // Pin the average brightness. Measured on the PHOTO, before the letterbox
    // goes on: the black bars are a third of this panel, and including them
    // would drag the mean down and have every frame brightened to compensate.
    const { channels } = await sharp(photo).stats();
    const mean = channels[0]?.mean ?? TARGET_MEAN;
    const gain = Math.min(MAX_GAIN, Math.max(MIN_GAIN, TARGET_MEAN / (mean || TARGET_MEAN)));

    // No contrast reading: this mode never renders black, so there is nothing
    // for the number to disambiguate.
    return { grey: await sharp(photo).linear(gain, 0).raw().toBuffer(), contrast: null };
}

/**
 * INK: the frame as marks on black — see the note at the top of the file.
 *
 * Subtract the frame's own local background from it and keep what is DARKER
 * than its surroundings. That is the definition of a mark on paper, and it is
 * the reason this survives what defeats the photo pipeline: uneven lighting, a
 * glare blob and a dark corner are all background by construction, so they
 * subtract away instead of having to be equalised around.
 */
async function inkPass(jpeg: Buffer, w: number, h: number, rotate: number): Promise<Pass> {
    const grey = await sharp(jpeg)
        .rotate(rotate)
        .resize(w, h)
        .greyscale() // before the median, so it filters one channel and not three
        // Before the difference, not after: a single bright JPEG pixel becomes a
        // large local difference, and the normalisation below would scale the
        // whole frame to it.
        .median(INK_DESPECKLE)
        .raw()
        .toBuffer();

    const background = await sharp(grey, { raw: { width: w, height: h, channels: 1 } })
        .blur(INK_SIGMA)
        // sharp hands a blurred single-channel buffer back as sRGB unless it is
        // asked not to, and the raw bytes would then be three-way interleaved —
        // every read below would be a different pixel's colour channel.
        .toColourspace("b-w")
        .raw()
        .toBuffer();

    // How far each pixel is below its own neighbourhood, and how much of that
    // there is at each level. One pass, because the histogram is only wanted
    // for the percentile below.
    const depth = Buffer.alloc(w * h);
    const histogram = new Uint32Array(256);
    for (let i = 0; i < depth.length; i++) {
        const below = background[i]! - grey[i]!;
        depth[i] = below > 0 ? below : 0;
        histogram[depth[i]!]!++;
    }

    let seen = 0;
    let top = 255;
    const target = depth.length * INK_PERCENTILE;
    for (let level = 0; level < 256; level++) {
        seen += histogram[level]!;
        if (seen >= target) {
            top = level;
            break;
        }
    }

    // The guard, not a clamp for tidiness: see INK_MIN_SPAN. A frame whose ink
    // is fainter than this is drawn at the strength it actually has, which is
    // to say barely at all.
    const span = Math.max(INK_MIN_SPAN, top - INK_FLOOR);

    // A lookup table rather than the curve per pixel — 256 pow() calls instead
    // of 145,000, on a frame that is rendered every second or two.
    const curve = new Uint8Array(256);
    for (let level = 0; level < 256; level++) {
        const t = Math.min(1, Math.max(0, (level - INK_FLOOR) / span));
        curve[level] = Math.round(255 * Math.pow(t, INK_GAMMA));
    }

    const out = Buffer.alloc(w * h);
    for (let i = 0; i < out.length; i++) out[i] = curve[depth[i]!]!;

    return { grey: out, contrast: top };
}

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
async function fitted(
    jpeg: Buffer,
    w: number,
    h: number,
    rotate: number,
    mode: PreviewMode,
): Promise<{ png: Buffer; contrast: number | null }> {
    const meta = await sharp(jpeg).rotate(rotate).metadata();
    const srcW = meta.width ?? w;
    const srcH = meta.height ?? h;
    const scale = Math.min(w / srcW, h / srcH);
    const drawnW = Math.round(srcW * scale);
    const drawnH = Math.round(srcH * scale);
    const left = Math.floor((w - drawnW) / 2);
    const top = Math.floor((h - drawnH) / 2);

    // Both passes work at the drawn size and pad afterwards. Neither can run on
    // the letterboxed image: CLAHE would find "contrast" in the black bars and
    // turn them to grey mush, and ink would read their edge as the strongest
    // mark in the frame and scale everything else down to suit it. The border
    // goes on last for the same reason.
    const pass =
        mode === "photo"
            ? await photoPass(jpeg, drawnW, drawnH, rotate)
            : await inkPass(jpeg, drawnW, drawnH, rotate);

    const frame = await sharp(pass.grey, {
        raw: { width: drawnW, height: drawnH, channels: 1 },
    })
        .extend({
            top,
            bottom: h - drawnH - top,
            left,
            right: w - drawnW - left,
            background: "#000",
        })
        // A format is required here: the pipeline started from raw pixels, so
        // there is no input format for sharp to carry over.
        .png()
        .toBuffer();

    // A white rectangle on the letterboxed image's own edge. Three pixels: a
    // hairline is what the panel loses first, and now that the picture itself
    // is deliberately dark, this line is the only thing separating the camera's
    // field of view from black bars and a dark room beyond them. It is the
    // difference between "the sheet runs off the side" and "the sheet ends
    // there".
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

    const png = await sharp(frame)
        .composite([
            { input: border, raw: { width: drawnW, height: drawnH, channels: 4 }, left, top },
        ])
        .png()
        .toBuffer();

    return { png, contrast: pass.contrast };
}

/**
 * One camera frame as tiles, indexed the way the client's containers are
 * (row-major from the top left). A 1-tile preview returns index 0 alone; the
 * client leaves the other three containers empty, which is black.
 */
export async function renderCameraTiles(
    jpeg: Buffer,
    opts: CameraTilesOptions = {},
): Promise<CameraPreview> {
    const size = opts.size ?? 4;
    const rotate = opts.rotate ?? 0;
    const mode = opts.mode ?? "ink";

    if (size === 1) {
        const small = await fitted(jpeg, TILE_W, TILE_H, rotate, mode);
        const data = await encodeTile([{ input: small.png, left: 0, top: 0 }], PREVIEW_ENCODE);
        return {
            tiles: [{ index: 0, data: data.toString("base64") }],
            contrast: small.contrast,
        };
    }

    const { png, contrast } = await fitted(jpeg, PAGE_W, PAGE_H, rotate, mode);
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

        tiles.push({
            index,
            data: (await encodeTile(layers, PREVIEW_ENCODE)).toString("base64"),
        });
    }

    return { tiles, contrast };
}
