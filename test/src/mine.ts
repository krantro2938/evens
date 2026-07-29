// The Mine page: your own answer to the scanned assignment, read back here.
//
// The AI page next door shows what Claude submitted. This one shows what YOU
// worked out, and they are separate pages because they used to be one: your
// answer was stored as another solution row, and the AI page shows the newest
// row whoever wrote it, so writing your own working hid the agent's. Two
// documents, two pages, neither overwriting the other.
//
// A reader, like the Adri page and for the same reason: there is exactly one of
// this document and nothing here to trigger. Editing happens in the companion
// app, and the version is a content hash — so saving on the phone pushes new
// tiles here without this page asking for anything.

import { DOC_BASE_MINE, GESTURE_EVENTS } from "./constants";
import { GlobalState, type DocState } from "./state";
import { createDocPage } from "./docPage";
import { ago } from "./utils";

const FOOTER_COLS = 40;

function clip(text: string, cols: number): string {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length <= cols ? line : `${line.slice(0, cols - 1)}…`;
}

function pagerLabel(state: DocState): string {
    // Ahead of everything else: a blank panel with a healthy footer is a link
    // failure, not an empty document, and the two look identical from here.
    if (state.linkError) return "Glasses link error - tiles not sent";

    // Served from the on-device cache because the server was unreachable. Said
    // before the page number, because it changes what the page number means.
    if (state.cachedAt) return clip(`Offline - cached ${ago(state.cachedAt)}`, FOOTER_COLS);

    if (!state.pages.length) return state.status;
    return clip(`Mine  ${state.currentPage + 1} / ${state.pages.length}`, FOOTER_COLS);
}

const page = createDocPage({
    name: "Mine",
    base: DOC_BASE_MINE,
    state: GlobalState.mineState,
    // A reader: tap and swipe both page, and there is nothing here to start.
    tapAction: "page",
    pagerLabel,
});

export async function enterMinePage(): Promise<void> {
    await page.enter();
}

export function leaveMinePage(): void {
    page.leave();
}

export function handleMinePageEvent(gesture: GESTURE_EVENTS): void {
    page.handleGesture(gesture);
}
