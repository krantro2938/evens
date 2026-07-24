import {
    ImageRawDataUpdate,
    TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import {
    AI_PAGER_ID,
    AI_TILE_IDS,
    GESTURE_EVENTS,
    MARKDOWN_SERVER_URL,
    POLL_INTERVAL_MS,
} from "./constants";
import { GlobalState } from "./state";
import { bridge, navigateBack } from "./main";
import { appLog } from "./debug";
import { renderMarkdownToHtml } from "./render/markdown";
import { renderToPages } from "./render/rasterize";

// The AI page fetches markdown from the server, renders it to PNG tiles, and
// pages through them. Live updates come over SSE; a 10s poll is the fallback.

let eventSource: EventSource | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let active = false;

// Which page's tiles are currently on the panel — avoids re-pushing over the
// slow BLE link when a gesture lands on the same page.
let displayedPage = -1;

// All bridge writes (tile pushes, pager updates, re-renders) run through this
// chain so nothing overlaps — updateImageRawData must be strictly serial.
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T | void> {
    chain = chain.then(task).catch((err) => appLog("AI task failed", err));
    return chain as Promise<T | void>;
}

function pagerLabel(): string {
    const { pages, currentPage, status } = GlobalState.aiState;
    if (!pages.length) return status;
    return `${currentPage + 1} / ${pages.length}  ·  swipe: page · double-tap: back`;
}

async function updatePager(): Promise<void> {
    await bridge.textContainerUpgrade(
        new TextContainerUpgrade({
            containerID: AI_PAGER_ID,
            containerName: "pager",
            content: pagerLabel(),
        }),
    );
}

async function showPage(index: number): Promise<void> {
    const { pages } = GlobalState.aiState;
    if (!pages.length) return;

    const clamped = Math.max(0, Math.min(index, pages.length - 1));
    if (clamped === displayedPage) return;

    GlobalState.aiState.currentPage = clamped;
    const page = pages[clamped];

    for (const tile of page.tiles) {
        const result = await bridge.updateImageRawData(
            new ImageRawDataUpdate({
                containerID: AI_TILE_IDS[tile.index],
                containerName: `tile${tile.index}`,
                imageData: tile.bytes,
            }),
        );
        if (result !== "success") {
            appLog("tile push", tile.index, String(result));
        }
    }
    displayedPage = clamped;
    await updatePager();
}

async function applyMarkdown(content: string, version: number): Promise<void> {
    GlobalState.aiState.status = "Rendering…";
    await updatePager();

    const html = await renderMarkdownToHtml(content);
    const pages = await renderToPages(html);

    GlobalState.aiState.pages = pages;
    GlobalState.aiState.version = version;
    GlobalState.aiState.currentPage = Math.min(
        GlobalState.aiState.currentPage,
        pages.length - 1,
    );
    // Force a redraw of whatever page we land on.
    displayedPage = -1;
    await showPage(GlobalState.aiState.currentPage);
}

interface Snapshot {
    content: string;
    version: number;
}

async function fetchSnapshot(): Promise<Snapshot> {
    const res = await fetch(`${MARKDOWN_SERVER_URL}/markdown`);
    if (!res.ok) throw new Error(`markdown HTTP ${res.status}`);
    return (await res.json()) as Snapshot;
}

async function applyIfNewer(content: string, version: number): Promise<void> {
    if (version <= GlobalState.aiState.version && GlobalState.aiState.pages.length) {
        return;
    }
    await applyMarkdown(content, version);
}

async function loadInitial(): Promise<void> {
    try {
        const { content, version } = await fetchSnapshot();
        await applyMarkdown(content, version);
    } catch (err) {
        appLog("AI initial load failed", err);
        GlobalState.aiState.status = `Load failed: ${
            err instanceof Error ? err.message : String(err)
        }`;
        await updatePager();
    }
}

function startPolling(): void {
    if (pollTimer) return;
    appLog("AI polling every", POLL_INTERVAL_MS, "ms");
    pollTimer = setInterval(() => {
        if (!active) return;
        enqueue(async () => {
            const { content, version } = await fetchSnapshot();
            await applyIfNewer(content, version);
        });
    }, POLL_INTERVAL_MS);
}

function subscribeLive(): void {
    try {
        eventSource = new EventSource(`${MARKDOWN_SERVER_URL}/events`);
        eventSource.addEventListener("markdown", (ev) => {
            try {
                const { content, version } = JSON.parse((ev as MessageEvent).data);
                enqueue(() => applyIfNewer(content, version));
            } catch (err) {
                appLog("SSE parse failed", err);
            }
        });
        eventSource.onerror = () => {
            // EventSource auto-reconnects; bring up the poll fallback so updates
            // still flow while it's down. fetchSnapshot dedupes by version.
            appLog("SSE error → enabling poll fallback");
            startPolling();
        };
    } catch (err) {
        appLog("SSE unavailable → polling", err);
        startPolling();
    }
}

/** Called by main.ts after the AI page containers are built. */
export async function enterAiPage(): Promise<void> {
    active = true;
    displayedPage = -1;
    GlobalState.aiState.status = "Loading…";
    await updatePager();
    enqueue(loadInitial);
    subscribeLive();
}

/** Tear down live connections when leaving the AI page. */
export function leaveAiPage(): void {
    active = false;
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

export function handleAiPageEvent(gesture: GESTURE_EVENTS) {
    switch (gesture) {
        case GESTURE_EVENTS.SWIPE_UP:
            enqueue(() => showPage(GlobalState.aiState.currentPage - 1));
            break;
        case GESTURE_EVENTS.SWIPE_DOWN:
        case GESTURE_EVENTS.TAP:
            enqueue(() => showPage(GlobalState.aiState.currentPage + 1));
            break;
        case GESTURE_EVENTS.DOUBLE_TAP:
            appLog("AI back gesture");
            leaveAiPage();
            navigateBack();
            break;
    }
}
