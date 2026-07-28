// The Adri page: a solution you wrote yourself, read back on the glasses.
//
// The simplest document page in the app, and deliberately so. The AI page has a
// solve button and a version picker because its document is produced by
// something you have to ask and wait for; the Assignment page has scan controls
// because its document comes off a camera you have to aim. This one is markdown
// you typed in the companion app — there is nothing here to trigger, nothing to
// aim, and nothing to choose between, because there is exactly one of it.
//
// So it is a reader: swipe or tap to page, double-tap to leave. Editing happens
// on the phone, and the page redraws on its own when it does — the version is a
// hash of the content, so saving in the companion app pushes new tiles here
// without anything being asked for.

import { DOC_BASE_ADRI, GESTURE_EVENTS } from "./constants";
import { GlobalState, type DocState } from "./state";
import { createDocPage } from "./docPage";
import { ago } from "./utils";

const FOOTER_COLS = 40;

function clip(text: string, cols: number): string {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length <= cols ? line : `${line.slice(0, cols - 1)}…`;
}

function pagerLabel(state: DocState): string {
    // Ahead of everything else, for the same reason it is on the other pages: a
    // blank panel with a healthy footer is a link failure, not an empty
    // document, and the two look identical from the outside.
    if (state.linkError) return "Glasses link error - tiles not sent";

    // These tiles came out of the on-device cache because the server was
    // unreachable. Said before the page number, because it changes what the
    // page number means.
    if (state.cachedAt) return clip(`Offline - cached ${ago(state.cachedAt)}`, FOOTER_COLS);

    if (!state.pages.length) return state.status;
    return clip(`Adri  ${state.currentPage + 1} / ${state.pages.length}`, FOOTER_COLS);
}

const page = createDocPage({
    name: "Adri",
    base: DOC_BASE_ADRI,
    state: GlobalState.adriState,
    // A reader: tap and swipe both page, and there is nothing here to start.
    tapAction: "page",
    pagerLabel,
});

export async function enterAdriPage(): Promise<void> {
    await page.enter();
}

export function leaveAdriPage(): void {
    page.leave();
}

export function handleAdriPageEvent(gesture: GESTURE_EVENTS): void {
    page.handleGesture(gesture);
}
