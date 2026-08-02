// The machinery behind any page that shows a server-rendered document: fetch
// tiles, page through them, stay live over SSE, fall back to polling and then
// to raw text. The AI page (solution.md) and the Assignment page (the lookcam
// reader) are both instances of this — they differ only in which endpoint they
// read, what the pager says, and what a tap does.
//
// Everything that used to be module-level in ai.ts is per-instance state here,
// so two pages can't tread on each other's displayed-tile bookkeeping.

import { TextContainerUpgrade } from "@evenrealities/even_hub_sdk";
import {
    DOC_EVENT_LAYER_ID,
    DOC_PAGER_ID,
    DOC_TILE_IDS,
    GESTURE_EVENTS,
    POLL_INTERVAL_MS,
} from "./constants";
import { serverUrl } from "./services/backend";
import type { DocState } from "./state";
import { bridge, navigateBack } from "./main";
import { appLog } from "./debug";
import { cachedTiles, fetchTiles, type TilePage } from "./render/tiles";
import { createTilePusher } from "./render/tilePush";

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
    /**
     * The page's status endpoint ("/solution/status"), polled through the same
     * `events.status` handler whenever the live stream is down.
     *
     * The document already had a poll fallback and its status did not, which is
     * not a symmetry anyone would choose: a dropped stream left the AI page
     * saying CLAUDE IS SOLVING with no way to ever learn otherwise, because the
     * event that says a run finished is pushed exactly once.
     */
    statusPath?: string;
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

/** The whole page, a few times per visit to it — the per-tile retry lives in
 *  tilePush.ts. */
const RETRY_DELAY_MS = 4_000;
const RETRIES_PER_VISIT = 3;

/**
 * The shortest gap between two paging swipes this page will act on.
 *
 * A page turn is a BLE tile push, and that takes long enough that the swipes
 * arriving while it runs all queue up behind it — so a touchpad that reports one
 * physical swipe twice, or a finger that bounced, walks the document two or
 * three pages past where you meant to stop, seconds after you stopped moving.
 * Dropping the extras is right rather than merely convenient: nothing here can
 * tell an accidental repeat from an intended one except the gap between them,
 * and a reader paging deliberately does not do it in under a third of a second.
 *
 * Only swipes are gated. Tap is a page turn on some pages too, but it is also
 * the confirm gesture, and a tap the page silently ignored would be a worse bug
 * than the one this fixes.
 */
const PAGE_SWIPE_MIN_GAP_MS = 350;

export function createDocPage(config: DocPageConfig): DocPage {
    const { state, base, name } = config;

    let eventSource: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let active = false;

    // Which page's tiles are currently on the panel — avoids re-pushing over the
    // slow BLE link when a gesture lands on the same page.
    let displayedPage = -1;

    // When the last paging swipe was accepted, for PAGE_SWIPE_MIN_GAP_MS. Read
    // and written on the gesture callback rather than inside `enqueue`: the
    // point is to refuse the swipe before it joins the queue, because a swipe
    // already on the queue is a page turn that will happen.
    let lastSwipeAt = 0;

    // Every write to an image container goes through here: dedup cache, retry,
    // and the BLE timing log. Shared with the Camera page (see tilePush.ts).
    const tiles = createTilePusher(name);

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

    // Retry bookkeeping for tiles the host couldn't send (see tilePush.ts).
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retriesLeft = RETRIES_PER_VISIT;

    // All bridge writes (tile pushes, pager updates, overlays) run through this
    // chain so nothing overlaps — updateImageRawData must be strictly serial.
    let chain: Promise<unknown> = Promise.resolve();
    function enqueue<T>(task: () => Promise<T>): Promise<T | void> {
        chain = chain.then(task).catch((err) => appLog(name, "task failed", err));
        return chain as Promise<T | void>;
    }

    // What the footer is showing. The pager is repainted on every status event,
    // every tick and every menu swipe, and most of those say the same thing —
    // and the elapsed-time tick runs once a second while a solve is in flight.
    // Reset on enter(): the container is rebuilt blank, so a dedup against the
    // last visit's text would leave the footer empty (see Panel.reset()).
    let shownPager: string | null = null;

    async function updatePager(): Promise<void> {
        const content = config.pagerLabel(state);
        if (content === shownPager) return;
        shownPager = content;
        await bridge.textContainerUpgrade(
            new TextContainerUpgrade({
                containerID: DOC_PAGER_ID,
                containerName: "pager",
                content,
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
        tiles.beginBatch(`page ${clamped}`);
        for (const tile of page.tiles) {
            landed = (await tiles.push(tile.index, tile.bytes)) && landed;
        }
        tiles.endBatch(page.tiles.length);

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
        tiles.beginBatch("overlay variant");
        for (const tile of page.tiles) await tiles.push(tile.index, tile.bytes);
        tiles.endBatch(page.tiles.length);
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
        tiles.beginBatch("overlay tiles");
        for (let i = 0; i < DOC_TILE_IDS.length; i++) {
            const b = bytes[i];
            if (b) await tiles.push(i, b);
        }
        tiles.endBatch(DOC_TILE_IDS.length);
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

    function applyTiles(
        pages: TilePage[],
        version: number,
        cachedAt: number | null = null,
    ): Promise<void> {
        state.pages = pages;
        state.version = version;
        // What the footer needs to stop presenting an old document as live.
        state.cachedAt = cachedAt;
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
        const res = await fetch(`${serverUrl()}${base}/markdown${config.query?.() ?? ""}`);
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
            tiles.reset();
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

        // Already rendered this exact document, on this device, before. The
        // version is the server's content hash, so a hit is the same bytes it
        // would send — and the fetch, the render and the wait are all skipped.
        const query = config.query?.() ?? "";
        const known = await cachedTiles(base, query, version);
        if (known) {
            appLog(name, "tiles from cache, version", version);
            await applyTiles(known.pages, known.version, known.cachedAt);
            return;
        }

        try {
            const { pages, version: tileVersion, cachedAt } = await fetchTiles(base, query);
            await applyTiles(pages, tileVersion, cachedAt);
        } catch (err) {
            appLog(name, "tiles fetch failed → text fallback", err);
            await showTextFallback();
        }
    }

    async function loadInitial(): Promise<void> {
        try {
            const { pages, version, cachedAt } = await fetchTiles(base, config.query?.());
            await applyTiles(pages, version, cachedAt);
        } catch (err) {
            appLog(name, "initial tiles failed → text fallback", err);
            await showTextFallback();
        }
    }

    /** The status the stream would have pushed, fetched the slow way. */
    async function pollStatus(): Promise<void> {
        const handler = config.events?.status;
        if (!config.statusPath || !handler || !active) return;
        try {
            const res = await fetch(`${serverUrl()}${config.statusPath}`);
            if (res.ok) handler(await res.json());
        } catch (err) {
            appLog(name, "status poll failed", err);
        }
    }

    function startPolling(): void {
        if (pollTimer) return;
        appLog(name, "polling every", POLL_INTERVAL_MS, "ms");
        // Immediately, not in POLL_INTERVAL_MS: the stream just dropped, and
        // whatever it failed to deliver is already stale.
        void pollStatus();
        pollTimer = setInterval(() => {
            if (!active) return;
            enqueue(async () => {
                const { version } = await fetchSnapshot();
                await refresh(version);
            });
            void pollStatus();
        }, POLL_INTERVAL_MS);
    }

    /** The stream is back, so stop paying for the fallback. */
    function stopPolling(): void {
        if (!pollTimer) return;
        clearInterval(pollTimer);
        pollTimer = null;
        appLog(name, "SSE recovered - polling off");
    }

    function subscribeLive(): void {
        try {
            eventSource = new EventSource(`${serverUrl()}${base}/events${config.query?.() ?? ""}`);
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
            // A reconnect re-sends status and document immediately, so the
            // fallback has nothing left to do. Without this the poll started on
            // the first blip ran for the rest of the visit.
            eventSource.onopen = stopPolling;
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
            tiles.reset();
            await enqueue(loadInitial);
            subscribeLive();
        },

        /** Called by main.ts after the page containers are built. */
        async enter(): Promise<void> {
            active = true;
            displayedPage = -1;
            lastSwipeAt = 0;
            retriesLeft = RETRIES_PER_VISIT;
            state.linkError = false;
            // Leaving the page with a menu open skips the backdrop teardown —
            // the containers are being destroyed anyway. Clearing this on the
            // way back in is what stops the page returning permanently blank.
            masked = false;
            tiles.reset();
            dropVariant();
            // Re-probed once per visit, so a server deployed while the app was
            // running is picked up by walking off the page and back on rather
            // than by reinstalling the app.
            variantUnsupported = false;
            shownPager = null;
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
                case GESTURE_EVENTS.SWIPE_DOWN: {
                    const now = Date.now();
                    if (now - lastSwipeAt < PAGE_SWIPE_MIN_GAP_MS) {
                        appLog(name, "swipe ignored - too soon after the last");
                        return;
                    }
                    lastSwipeAt = now;
                    const step = gesture === GESTURE_EVENTS.SWIPE_UP ? -1 : 1;
                    enqueue(() => showPage(state.currentPage + step));
                    break;
                }
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
