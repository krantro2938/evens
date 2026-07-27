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
    IMAGE_PAYLOAD,
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
    query?(): string;
    /**
     * Query for an alternate render of the same document, with a rectangle
     * reserved for an overlay panel (`?overlay=menu`). Same markdown and the
     * same pagination, so page N of one is page N of the other — which is what
     * lets `overlayVariant()` swap the tiles of the page you are already on.
     *
     * Fetched lazily in the background after the document lands. Omit it and
     * the page simply has no variant.
     */
    variantQuery?(): string;
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
    /**
     * Mask with the variant render instead: the document as it is, with the
     * overlay's rectangle already dark and framed in the tiles. Costs four real
     * tiles (~8KB) rather than the backdrop's ~1KB, and buys a menu you can
     * read the solution around.
     *
     * False when the variant isn't loaded yet — the caller should fall back to
     * `overlayTiles`, because a menu over an unmasked document is unreadable.
     * The fetch it kicks off means the next open gets the real thing.
     */
    overlayVariant(): Promise<boolean>;
    /** Put the document's own tiles back after an overlay. */
    restoreTiles(): Promise<void>;
    /**
     * Whether an overlay currently owns the tiles.
     *
     * The one honest answer to "is the document visible right now", and the
     * reason it is exposed: an owner that kept its own copy of this would be
     * reading a snapshot taken before the write queue drained, and would decide
     * to leave the backdrop up on a page that had already moved on. Read it
     * inside `enqueue`, where it is the truth.
     */
    isMasked(): boolean;
    reload(): Promise<void>;
}

interface Snapshot {
    content: string;
    version: number;
}

/** A tile the host failed to *send* is worth trying again, briefly. */
const PUSH_ATTEMPTS = 3;
const PUSH_RETRY_MS = 400;
/** Then, one level up: the whole page, a few times per visit to the page. */
const RETRY_DELAY_MS = 4_000;
const RETRIES_PER_VISIT = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

    // The variant render — the same pages with the overlay's box baked in. Held
    // with the version it was rendered for, because it is fetched a moment
    // after the document and a solve landing in between would otherwise leave
    // the menu masking the *previous* solution.
    let variantPages: TilePage[] | null = null;
    let variantVersion = -1;
    let variantInFlight: Promise<void> | null = null;
    // Set once a server has answered `?overlay=` without reserving anything.
    // Then there is no variant to be had from it, and asking again on every
    // document change is a wasted render per solve.
    let variantUnsupported = false;

    // Retry bookkeeping for tiles the host couldn't send (see pushTile).
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retriesLeft = RETRIES_PER_VISIT;

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

        let landed = true;
        for (const tile of page.tiles) {
            landed = (await pushTile(tile.index, tile.bytes)) && landed;
        }

        if (landed) {
            displayedPage = clamped;
            state.linkError = false;
        } else {
            // Do NOT record this page as displayed: a later gesture or document
            // update must be free to try again, and the early-return on
            // `clamped === displayedPage` would otherwise make a transient
            // failure permanent — a blank panel until the page number changed.
            displayedPage = -1;
            state.linkError = true;
            scheduleRetry();
        }
        await updatePager();
        await config.afterShow?.();
    }

    /**
     * Try the page again after a link failure. Bounded: a link that is properly
     * down (glasses asleep, host app gone) should leave the pager saying so
     * rather than retrying all evening — and any gesture or document update
     * retries anyway, because the failure left `displayedPage` unset.
     */
    function scheduleRetry(): void {
        if (retryTimer || retriesLeft <= 0 || !active) return;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            if (!active || !state.linkError) return;
            retriesLeft -= 1;
            appLog(name, "retrying tiles after link failure");
            enqueue(() => showPage(state.currentPage));
        }, RETRY_DELAY_MS);
    }

    /**
     * Push one image into a tile container, keeping the dedup cache honest.
     * Returns false if the tile is not on the panel afterwards.
     *
     * `sendFailed` is the host telling us the BLE transfer to the glasses failed
     * — the image itself was fine (that would be imageException or
     * imageSizeInvalid). A tile is ~18KB of gray4 where a text upgrade is a few
     * bytes, so a weak link drops these and nothing else, and the page goes blank
     * while the pager keeps updating perfectly. It is also usually transient,
     * which is the whole reason to try again.
     */
    async function pushTile(index: number, bytes: Uint8Array): Promise<boolean> {
        if (sameBytes(displayedTiles[index], bytes)) return true;

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
                displayedTiles[index] = bytes;
                return true;
            }

            appLog(name, "tile push", index, String(result), `attempt ${attempt}`);
            displayedTiles[index] = null;
            // A rejected image will be rejected again; only the transport is
            // worth a second go.
            if (String(result) !== "sendFailed") return false;
            if (attempt < PUSH_ATTEMPTS) await sleep(PUSH_RETRY_MS);
        }
        return false;
    }

    /**
     * Fetch the variant render in the background. Not awaited by anything that
     * draws: the document is already on screen and the variant only matters
     * once a menu opens, so a slow render must not hold up the page.
     */
    function loadVariant(): void {
        if (!config.variantQuery || variantInFlight || !active) return;
        if (variantUnsupported) return;
        // Nothing to be a variant OF yet; applyTiles calls back in when there is.
        if (!state.pages.length) return;
        variantInFlight = (async () => {
            try {
                const { pages, version, overlay } = await fetchTiles(
                    base,
                    config.variantQuery!(),
                );
                // A server that ignored the query hands back the plain document
                // and looks, from here, exactly like a successful variant fetch
                // — until the menu opens over it and is transparent. Take the
                // plain backdrop instead; it is ugly and it is legible.
                if (!overlay) {
                    variantUnsupported = true;
                    appLog(name, "server has no overlay render - menu stays on the backdrop");
                    return;
                }
                variantPages = pages;
                variantVersion = version;
            } catch (err) {
                // The menu still works, on the plain backdrop. Not worth a retry
                // loop: the next document change asks again.
                appLog(name, "overlay variant fetch failed", err);
            } finally {
                variantInFlight = null;
            }
        })();
    }

    function dropVariant(): void {
        variantPages = null;
        variantVersion = -1;
    }

    async function overlayVariant(): Promise<boolean> {
        // A variant rendered from different markdown would mask the document
        // with someone else's text. Only an exact version match will do.
        if (!variantPages || variantVersion !== state.version || !state.pages.length) {
            loadVariant();
            return false;
        }
        const page = variantPages[Math.min(state.currentPage, variantPages.length - 1)];
        if (!page) return false;
        for (const tile of page.tiles) await pushTile(tile.index, tile.bytes);
        // Same bookkeeping as overlayTiles: the containers no longer show the
        // page they claim to, so restoreTiles has to push it again.
        displayedPage = -1;
        masked = true;
        return true;
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
        // The variant is a render of the document that just went stale.
        dropVariant();
        loadVariant();
        state.currentPage = Math.min(
            state.currentPage,
            Math.max(0, pages.length - 1),
        );
        // Force a redraw of whatever page we land on.
        displayedPage = -1;
        return showPage(state.currentPage);
    }

    async function fetchSnapshot(): Promise<Snapshot> {
        const res = await fetch(`${MARKDOWN_SERVER_URL}${base}/markdown${config.query?.() ?? ""}`);
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
            const { pages, version: tileVersion } = await fetchTiles(base, config.query?.());
            await applyTiles(pages, tileVersion);
        } catch (err) {
            appLog(name, "tiles fetch failed → text fallback", err);
            await showTextFallback();
        }
    }

    async function loadInitial(): Promise<void> {
        try {
            const { pages, version } = await fetchTiles(base, config.query?.());
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
            eventSource = new EventSource(`${MARKDOWN_SERVER_URL}${base}/events${config.query?.() ?? ""}`);
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
        overlayVariant,
        restoreTiles,
        isMasked: () => masked,
        async reload(): Promise<void> {
            if (!active) return;
            eventSource?.close();
            eventSource = null;
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = null;
            displayedPage = -1;
            // A reload is a different document (the AI page pinning an older
            // solution), so the variant is not the one we want either.
            dropVariant();
            // And nothing queued should put the OUTGOING document back on the
            // way past: a menu closing enqueues a restore, and it would spend a
            // full four-tile push over BLE showing the version you just left.
            // loadInitial draws what actually replaces it.
            masked = false;
            resetDisplayedTiles();
            await enqueue(loadInitial);
            subscribeLive();
        },

        /** Called by main.ts after the page containers are built. */
        async enter(): Promise<void> {
            active = true;
            displayedPage = -1;
            retriesLeft = RETRIES_PER_VISIT;
            state.linkError = false;
            // Leaving the page with a menu open skips the backdrop teardown —
            // the containers are being destroyed anyway. Clearing this on the
            // way back in is what stops the page returning permanently blank.
            masked = false;
            resetDisplayedTiles();
            dropVariant();
            // Re-probed once per visit, so a server deployed while the app was
            // running is picked up by walking off the page and back on rather
            // than by reinstalling the app.
            variantUnsupported = false;
            state.status = "Loading...";
            await updatePager();
            enqueue(loadInitial);
            subscribeLive();
        },

        /** Tear down live connections when leaving the page. */
        leave(): void {
            active = false;
            if (retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = null;
            }
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
