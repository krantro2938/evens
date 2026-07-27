// Getting an image into one of the four tile containers, and knowing whether it
// arrived.
//
// Extracted from docPage.ts because the Camera page pushes tiles too, and this
// is the code least worth having two copies of: the legacy payload shape, the
// sendFailed retry and the dedup cache are each here because of a specific
// failure that took a while to find (see IMAGE_PAYLOAD in constants.ts).
//
// It also owns the BLE instrumentation, which is where the numbers behind the
// camera preview's pacing come from — the link, not the render, is the budget.

import { ImageRawDataUpdate } from "@evenrealities/even_hub_sdk";
import { DOC_TILE_IDS, IMAGE_PAYLOAD } from "../constants";
import { bridge } from "../main";
import { appLog } from "../debug";

/** A tile the host failed to *send* is worth trying again, briefly. */
const PUSH_ATTEMPTS = 3;
const PUSH_RETRY_MS = 400;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface TilePusher {
    /** Put bytes in container `index`; false if they are not on the panel after. */
    push(index: number, bytes: Uint8Array): Promise<boolean>;
    /** Forget what each container shows — after a page rebuild, which blanks them. */
    reset(): void;
    /** Start timing a group of pushes (a page turn, a preview frame). */
    beginBatch(label: string): void;
    /** Close the group and log what it cost. */
    endBatch(tiles: number): void;
    /** Milliseconds the last completed batch took, 0 if nothing was sent. */
    lastBatchMs(): number;
}

export function createTilePusher(name: string): TilePusher {
    // Bytes currently shown in each of the four image containers. Turning a page
    // still pushes all four tiles, but adjacent pages often share identical tiles
    // (blank/all-black regions), and re-pushing those over BLE is the dominant
    // cost — so skip any tile whose bytes already match what its container shows.
    let displayed: (Uint8Array | null)[] = [null, null, null, null];

    // What a batch of tile pushes actually costs over BLE. The link is the
    // budget for anything that repaints on a timer — a camera preview most of
    // all — and it has only ever been described here as "slow". Measured in
    // KB/s rather than ms/tile because tiles are PNGs and their size varies by
    // an order of magnitude with content: a text tile off the document server
    // is ~1.8KB, the same rectangle holding a photograph is ~8.4KB, because
    // black-background text palette-compresses and a camera frame does not.
    let batch: { label: string; at: number; sent: number[]; bytes: number } | null = null;
    let lastMs = 0;

    function sameBytes(a: Uint8Array | null, b: Uint8Array): boolean {
        if (!a || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    return {
        reset(): void {
            displayed = [null, null, null, null];
        },

        beginBatch(label: string): void {
            batch = { label, at: Date.now(), sent: [], bytes: 0 };
        },

        /** Close the batch and log it, unless the dedup cache made it free. */
        endBatch(tiles: number): void {
            if (!batch) return;
            const { label, at, sent, bytes } = batch;
            batch = null;
            if (!sent.length) return;
            const total = Date.now() - at;
            lastMs = total;
            const kb = bytes / 1024;
            appLog(
                name,
                "ble",
                label,
                `${sent.length}/${tiles} tiles`,
                `${kb.toFixed(1)}KB`,
                `${total}ms`,
                `${(kb / (total / 1000)).toFixed(1)}KB/s`,
                `[${sent.join(" ")}]`,
            );
        },

        lastBatchMs: () => lastMs,

        /**
         * `sendFailed` is the host telling us the BLE transfer to the glasses
         * failed — the image itself was fine (that would be imageException or
         * imageSizeInvalid). A tile is ~18KB of gray4 where a text upgrade is a
         * few bytes, so a weak link drops these and nothing else, and the page
         * goes blank while the pager keeps updating perfectly. It is also
         * usually transient, which is the whole reason to try again.
         */
        async push(index: number, bytes: Uint8Array): Promise<boolean> {
            if (sameBytes(displayed[index], bytes)) return true;

            const started = Date.now();
            const update = new ImageRawDataUpdate({
                containerID: DOC_TILE_IDS[index],
                containerName: `tile${index}`,
                imageData: bytes,
            });

            if (IMAGE_PAYLOAD === "legacy") {
                // Send what 0.0.10 sent. The SDK's own toJson() adds
                // `compressMode: 2` unconditionally, and a host that predates LZ4
                // support answers every such send with sendFailed — see the note at
                // IMAGE_PAYLOAD. Overriding toJson is the whole of the fix: the
                // bridge serializes through it.
                (update as unknown as { toJson(): unknown }).toJson = () => ({
                    containerID: DOC_TILE_IDS[index],
                    containerName: `tile${index}`,
                    imageData: Array.from(bytes),
                });
            }

            for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
                const result = await bridge.updateImageRawData(update);
                if (result === "success") {
                    displayed[index] = bytes;
                    if (batch) {
                        // Attempts included: a tile that needed two goes really
                        // did cost the link that long.
                        batch.sent.push(Date.now() - started);
                        batch.bytes += bytes.length;
                    }
                    return true;
                }

                appLog(name, "tile push", index, String(result), `attempt ${attempt}`);
                displayed[index] = null;
                // A rejected image will be rejected again; only the transport is
                // worth a second go.
                if (String(result) !== "sendFailed") return false;
                if (attempt < PUSH_ATTEMPTS) await sleep(PUSH_RETRY_MS);
            }
            return false;
        },
    };
}
