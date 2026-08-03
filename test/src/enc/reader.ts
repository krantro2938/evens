// Reading one encyclopedia node.
//
// Not a docPage. That component fetches markdown, holds an SSE connection,
// polls for changes, keeps a variant render for the action menu and falls back
// to text when a render fails — and every one of those exists because the
// documents it shows CHANGE. This one cannot: it is a file that was rendered in
// 2026 and committed, keyed by a hash of itself. There is nothing to subscribe
// to, nothing to poll and nothing to fall back to, because there is no render
// step that could fail.
//
// What it does have that a docPage does not is two kinds of page. A node
// interleaves prose that shipped as text with formulas that shipped as images
// (tools/enc/paginate.ts decides which, per run of blocks). Both live in ONE
// container layout, so switching between them is a container write rather than
// a page rebuild:
//
//   text page   blank tiles pushed under it, body container carries the text
//   image page  body cleared, the four real tiles pushed
//
// The blank tiles matter more than they look. Image containers keep whatever
// was last written to them, so without this a text page would appear on top of
// the previous page's formula. And because tilePush dedupes by bytes, walking
// through ten text pages in a row costs ONE push, not forty.

import { TextContainerUpgrade } from "@evenrealities/even_hub_sdk";
import { ENC_BODY_ID, ENC_PAGER_ID, ENC_TILE_IDS, GESTURE_EVENTS } from "../constants";
import { bridge, navigate } from "../main";
import { PAGES } from "../constants";
import { appLog } from "../debug";
import { base64ToBytes } from "../render/tiles";
import { createTilePusher } from "../render/tilePush";
import { loadNode, loadToc, type EncNodeDoc } from "./pack";

/** Matches docPage's PAGE_SWIPE_MIN_GAP_MS, and for the same reason. */
const SWIPE_MIN_GAP_MS = 350;

const tiles = createTilePusher("Enc");

let doc: EncNodeDoc | null = null;
let title = "";
let page = 0;
let active = false;
let lastSwipeAt = 0;
let error = "";

/** Four blank tiles, decoded once from the tree. */
let blank: Uint8Array[] | null = null;

/**
 * All bridge writes run through one chain.
 *
 * `updateImageRawData` must be strictly serial, and a page turn is a tile push
 * plus two text writes. NOTHING THAT TOUCHES THE NETWORK MAY RUN IN HERE — the
 * same rule as docPage.ts, for the same reason: the chain is the only route to
 * the screen, and one hung request in it presents as an app that has locked up.
 */
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T | void> {
    chain = chain.then(task).catch((err) => appLog("Enc", "reader task failed", err));
    return chain as Promise<T | void>;
}

async function blankTiles(): Promise<Uint8Array[]> {
    if (blank) return blank;
    const toc = await loadToc();
    if (!toc?.blank) {
        // An all-black 288×126 PNG is what the pack ships; without it the tiles
        // simply keep the previous page, which is wrong but readable. Better
        // than refusing to show the text.
        appLog("Enc", "pack has no blank tile — text pages will not clear the tiles");
        return [];
    }
    const one = base64ToBytes(toc.blank);
    blank = [one, one, one, one];
    return blank;
}

/**
 * Load a node and make it the one being read. Called by the browser BEFORE it
 * navigates, so the page builds with something already in hand.
 */
export async function openNode(id: string): Promise<void> {
    error = "";
    page = 0;
    doc = await loadNode(id);
    const toc = await loadToc();
    title = toc?.nodes[id]?.title ?? doc?.title ?? id;
    if (!doc) error = "Нет в кэше и сервер не отвечает";
}

function pagerLabel(): string {
    if (error) return error.slice(0, 52);
    if (!doc?.pages.length) return "Пусто";
    const where = `${page + 1}/${doc.pages.length}`;
    const room = 52 - where.length - 2;
    return `${title.length > room ? `${title.slice(0, room - 1)}…` : title}  ${where}`;
}

async function writeText(containerID: number, name: string, content: string): Promise<void> {
    await bridge.textContainerUpgrade(
        new TextContainerUpgrade({ containerID, containerName: name, content }),
    );
}

let shownPager: string | null = null;
let shownBody: string | null = null;

async function paint(): Promise<void> {
    const current = doc?.pages[page];

    if (!current) {
        await enqueue(async () => {
            if (shownBody !== error) {
                shownBody = error;
                await writeText(ENC_BODY_ID, "encBody", error || " ");
            }
            const pager = pagerLabel();
            if (shownPager !== pager) {
                shownPager = pager;
                await writeText(ENC_PAGER_ID, "pager", pager);
            }
        });
        return;
    }

    const bytes =
        current.kind === "tiles"
            ? current.tiles.map(base64ToBytes)
            : await blankTiles();
    // The body is blank on an image page: the tiles carry everything, and a
    // text container over them is transparent, so anything left here would
    // print straight across the formula.
    const body = current.kind === "text" ? current.text : " ";

    await enqueue(async () => {
        if (!active) return;
        // Tiles first. The text is what changes visibly, and writing it before
        // the image underneath has landed shows the new page's words over the
        // old page's picture for as long as the BLE push takes.
        // An INDEX, not a container id: the pusher maps it through
        // DOC_TILE_IDS itself (see render/tilePush.ts), which is exactly why
        // ENC_TILE_IDS aliases that list rather than repeating it.
        for (let i = 0; i < ENC_TILE_IDS.length && i < bytes.length; i++) {
            await tiles.push(i, bytes[i]);
        }
        if (shownBody !== body) {
            shownBody = body;
            await writeText(ENC_BODY_ID, "encBody", body);
        }
        const pager = pagerLabel();
        if (shownPager !== pager) {
            shownPager = pager;
            await writeText(ENC_PAGER_ID, "pager", pager);
        }
    });
}

export async function enterEncReadPage(): Promise<void> {
    active = true;
    // The containers were rebuilt blank by buildPage, so the dedup state has to
    // go with them — otherwise a repaint that matches the last visit's text
    // leaves the panel empty.
    shownPager = null;
    shownBody = null;
    tiles.reset();
    await paint();
}

export function leaveEncReadPage(): void {
    active = false;
}

function turn(step: number): void {
    if (!doc?.pages.length) return;
    const next = Math.min(doc.pages.length - 1, Math.max(0, page + step));
    if (next === page) return;
    page = next;
    void paint();
}

export function handleEncReadPageEvent(gesture: GESTURE_EVENTS): void {
    switch (gesture) {
        case GESTURE_EVENTS.SWIPE_UP:
        case GESTURE_EVENTS.SWIPE_DOWN: {
            // Refused BEFORE it joins the queue: a swipe already on the chain is
            // a page turn that is going to happen, seconds after you stopped
            // moving. Taps are deliberately not debounced (see docPage.ts).
            const now = Date.now();
            if (now - lastSwipeAt < SWIPE_MIN_GAP_MS) return;
            lastSwipeAt = now;
            turn(gesture === GESTURE_EVENTS.SWIPE_UP ? -1 : 1);
            break;
        }

        case GESTURE_EVENTS.TAP:
            turn(1);
            break;

        case GESTURE_EVENTS.DOUBLE_TAP:
            // Back to the tree, on the row this node was opened from — the
            // browser keeps its stack across a visit here. Going to the
            // dashboard instead would mean re-walking four levels to read the
            // next worked example.
            navigate(PAGES.ENC_BROWSE);
            break;
    }
}

/** Whether anything is loaded — the page builder uses it to size the layout. */
export const hasNode = (): boolean => doc !== null;
