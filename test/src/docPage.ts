// The machinery behind any page that shows a server-rendered document: fetch
// tiles, page through them, stay live over SSE, fall back to polling and then
// to raw text. The AI page (solution.md) and the Assignment page (the lookcam
// reader) are both instances of this — they differ only in which endpoint they
// read, what the pager says, and what a tap does.
//
// Everything that used to be module-level in ai.ts is per-instance state here,
// so two pages can't tread on each other's displayed-tile bookkeeping.

import {
    ImageRawDataUpdate,
    TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import {
    DOC_EVENT_LAYER_ID,
    DOC_PAGER_ID,
    DOC_TILE_IDS,
    GESTURE_EVENTS,
    MARKDOWN_SERVER_URL,
    POLL_INTERVAL_MS,
} from "./constants";
import type { DocState } from "./state";
import { bridge, navigateBack } from "./main";
import { appLog } from "./debug";
import { fetchTiles, type TilePage } from "./render/tiles";

export interface DocPageConfig {
    /** Shown in log lines. */
    name: string;
    /** Path prefix on the document server: "" for solution.md, "/assignment". */
    base: string;
    /** The slice of GlobalState this page renders from. */
    state: DocState;
    /** Single line for the pager container. */
    pagerLabel(state: DocState): string;
    /**
     * What a tap does. "page" turns to the next page (the AI page's reading
     * gesture); "action" calls onPrimaryAction instead, for pages whose tap is
     * a button. Swipes always page either way.
     */
    tapAction?: "page" | "action";
    onPrimaryAction?(): void;
    /** Extra SSE events to listen for, beyond `markdown`. */
    events?: Record<string, (data: unknown) => void>;
    /** Run after tiles land, e.g. to refresh an overlay container. */
    afterShow?(): Promise<void>;
}

export interface DocPage {
    enter(): Promise<void>;
    leave(): void;
    handleGesture(gesture: GESTURE_EVENTS): void;
    /** Serialize a bridge write into this page's write chain. */
    enqueue<T>(task: () => Promise<T>): Promise<T | void>;
    updatePager(): Promise<void>;
    /**
     * Replace the image tiles with something else — an overlay's backdrop.
     * Text containers are transparent, so anything drawn over the document is
     * unreadable until the tiles underneath stop showing the document.
     * No-op when there are no tiles to put back afterwards.
     */
    overlayTiles(bytes: readonly Uint8Array[]): Promise<void>;
    /** Put the document's own tiles back after an overlay. */
    restoreTiles(): Promise<void>;
}

interface Snapshot {
    content: string;
    version: number;
}

export function createDocPage(config: DocPageConfig): DocPage {
    const { state, base, name } = config;

    let eventSource: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let active = false;

    // Which page's tiles are currently on the panel — avoids re-pushing over the
    // slow BLE link when a gesture lands on the same page.
    let displayedPage = -1;

    // Bytes currently shown in each of the four image containers. Turning a page
    // still pushes all four tiles, but adjacent pages often share identical tiles
    // (blank/all-black regions), and re-pushing those over BLE is the dominant
    // cost — so skip any tile whose bytes already match what its container shows.
    let displayedTiles: (Uint8Array | null)[] = [null, null, null, null];

    // True while an overlay (the action menu's backdrop) has taken the tiles
    // over. Document updates keep flowing into `state`; they just don't reach
    // the screen until the overlay comes down.
    let masked = false;

    function sameBytes(a: Uint8Array | null, b: Uint8Array): boolean {
        if (!a || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    function resetDisplayedTiles(): void {
        displayedTiles = [null, null, null, null];
    }

    // All bridge writes (tile pushes, pager updates, overlays) run through this
    // chain so nothing overlaps — updateImageRawData must be strictly serial.
    let chain: Promise<unknown> = Promise.resolve();
    function enqueue<T>(task: () => Promise<T>): Promise<T | void> {
        chain = chain.then(task).catch((err) => appLog(name, "task failed", err));
        return chain as Promise<T | void>;
    }

    async function updatePager(): Promise<void> {
        await bridge.textContainerUpgrade(
            new TextContainerUpgrade({
                containerID: DOC_PAGER_ID,
                containerName: "pager",
                content: config.pagerLabel(state),
            }),
        );
    }

    async function showPage(index: number): Promise<void> {
        const { pages } = state;
        if (!pages.length) return;
        // An overlay owns the tiles. A document update landing now would draw
        // the page straight over it — and on the assignment page one lands
        // every few seconds while a scan runs. The new tiles are already in
        // `state`, so restoreTiles() will show them.
        if (masked) return;

        const clamped = Math.max(0, Math.min(index, pages.length - 1));
        if (clamped === displayedPage) return;

        state.currentPage = clamped;
        const page = pages[clamped];

        for (const tile of page.tiles) await pushTile(tile.index, tile.bytes);
        displayedPage = clamped;
        await updatePager();
        await config.afterShow?.();
    }

    /** Push one image into a tile container, keeping the dedup cache honest. */
    async function pushTile(index: number, bytes: Uint8Array): Promise<void> {
        if (sameBytes(displayedTiles[index], bytes)) return;
        const result = await bridge.updateImageRawData(
            new ImageRawDataUpdate({
                containerID: DOC_TILE_IDS[index],
                containerName: `tile${index}`,
                imageData: bytes,
            }),
        );
        if (result !== "success") {
            appLog(name, "tile push", index, String(result));
            displayedTiles[index] = null;
            return;
        }
        displayedTiles[index] = bytes;
    }

    async function overlayTiles(bytes: readonly Uint8Array[]): Promise<void> {
        // Nothing to restore afterwards means the containers were never filled;
        // covering them would strand the overlay on screen.
        if (!state.pages.length) return;
        for (let i = 0; i < DOC_TILE_IDS.length; i++) {
            const b = bytes[i];
            if (b) await pushTile(i, b);
        }
        // The containers no longer show the page they claim to.
        displayedPage = -1;
        masked = true;
    }

    async function restoreTiles(): Promise<void> {
        if (!masked) return;
        masked = false;
        displayedPage = -1;
        await showPage(state.currentPage);
    }

    function applyTiles(pages: TilePage[], version: number): Promise<void> {
        state.pages = pages;
        state.version = version;
        state.currentPage = Math.min(
            state.currentPage,
            Math.max(0, pages.length - 1),
        );
        // Force a redraw of whatever page we land on.
        displayedPage = -1;
        return showPage(state.currentPage);
    }

    async function fetchSnapshot(): Promise<Snapshot> {
        const res = await fetch(`${MARKDOWN_SERVER_URL}${base}/markdown`);
        if (!res.ok) throw new Error(`markdown HTTP ${res.status}`);
        return (await res.json()) as Snapshot;
    }

    // Tiles unavailable (server down, render failed): show the raw markdown as
    // text in the full-screen event layer so the page is at least readable.
    async function showTextFallback(): Promise<void> {
        try {
            const { content, version } = await fetchSnapshot();
            state.pages = [];
            state.version = version;
            state.status = "Text mode (tiles unavailable)";
            displayedPage = -1;
            resetDisplayedTiles();
            await bridge.textContainerUpgrade(
                new TextContainerUpgrade({
                    containerID: DOC_EVENT_LAYER_ID,
                    containerName: "docEvent",
                    content,
                }),
            );
            await updatePager();
        } catch (err) {
            appLog(name, "text fallback failed", err);
            state.status = `Load failed: ${
                err instanceof Error ? err.message : String(err)
            }`;
            await updatePager();
        }
    }

    // Fetch and show the latest tiles, unless we already have this version.
    // Compared by inequality, not by ordering: solution.md versions are mtimes
    // and only ever climb, but the assignment's is a content hash, so a newer
    // document is as likely to hash lower as higher.
    async function refresh(version: number): Promise<void> {
        if (version === state.version && state.pages.length) return;
        try {
            const { pages, version: tileVersion } = await fetchTiles(base);
            await applyTiles(pages, tileVersion);
        } catch (err) {
            appLog(name, "tiles fetch failed → text fallback", err);
            await showTextFallback();
        }
    }

    async function loadInitial(): Promise<void> {
        try {
            const { pages, version } = await fetchTiles(base);
            await applyTiles(pages, version);
        } catch (err) {
            appLog(name, "initial tiles failed → text fallback", err);
            await showTextFallback();
        }
    }

    function startPolling(): void {
        if (pollTimer) return;
        appLog(name, "polling every", POLL_INTERVAL_MS, "ms");
        pollTimer = setInterval(() => {
            if (!active) return;
            enqueue(async () => {
                const { version } = await fetchSnapshot();
                await refresh(version);
            });
        }, POLL_INTERVAL_MS);
    }

    function subscribeLive(): void {
        try {
            eventSource = new EventSource(`${MARKDOWN_SERVER_URL}${base}/events`);
            eventSource.addEventListener("markdown", (ev) => {
                try {
                    const { version } = JSON.parse((ev as MessageEvent).data);
                    enqueue(() => refresh(version));
                } catch (err) {
                    appLog(name, "SSE parse failed", err);
                }
            });
            for (const [event, handler] of Object.entries(config.events ?? {})) {
                eventSource.addEventListener(event, (ev) => {
                    try {
                        handler(JSON.parse((ev as MessageEvent).data));
                    } catch (err) {
                        appLog(name, `SSE ${event} failed`, err);
                    }
                });
            }
            eventSource.onerror = () => {
                // EventSource auto-reconnects; bring up the poll fallback so
                // updates still flow while it's down. refresh dedupes by version.
                appLog(name, "SSE error → enabling poll fallback");
                startPolling();
            };
        } catch (err) {
            appLog(name, "SSE unavailable → polling", err);
            startPolling();
        }
    }

    return {
        enqueue,
        updatePager,
        overlayTiles,
        restoreTiles,

        /** Called by main.ts after the page containers are built. */
        async enter(): Promise<void> {
            active = true;
            displayedPage = -1;
            // Leaving the page with a menu open skips the backdrop teardown —
            // the containers are being destroyed anyway. Clearing this on the
            // way back in is what stops the page returning permanently blank.
            masked = false;
            resetDisplayedTiles();
            state.status = "Loading...";
            await updatePager();
            enqueue(loadInitial);
            subscribeLive();
        },

        /** Tear down live connections when leaving the page. */
        leave(): void {
            active = false;
            if (eventSource) {
                eventSource.close();
                eventSource = null;
            }
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
        },

        handleGesture(gesture: GESTURE_EVENTS): void {
            switch (gesture) {
                case GESTURE_EVENTS.SWIPE_UP:
                    enqueue(() => showPage(state.currentPage - 1));
                    break;
                case GESTURE_EVENTS.SWIPE_DOWN:
                    enqueue(() => showPage(state.currentPage + 1));
                    break;
                case GESTURE_EVENTS.TAP:
                    if (config.tapAction === "action") config.onPrimaryAction?.();
                    else enqueue(() => showPage(state.currentPage + 1));
                    break;
                case GESTURE_EVENTS.DOUBLE_TAP:
                    appLog(name, "back gesture");
                    this.leave();
                    navigateBack();
                    break;
            }
        },
    };
}
