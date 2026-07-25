// The AI page: solution.md, server-rendered into tiles and paged through.
// All the machinery lives in docPage.ts — this is just the configuration that
// points it at solution.md.

import { DOC_BASE_SOLUTION, GESTURE_EVENTS } from "./constants";
import { GlobalState } from "./state";
import { createDocPage } from "./docPage";

const page = createDocPage({
    name: "AI",
    base: DOC_BASE_SOLUTION,
    state: GlobalState.aiState,
    // Tap turns the page here — this page is for reading, not controlling.
    tapAction: "page",
    pagerLabel(state) {
        if (!state.pages.length) return state.status;
        // Keep this to a single line — the text container shows a scroller when
        // its content overflows the pager height, and a longer hint wrapped.
        return `${state.currentPage + 1} / ${state.pages.length}`;
    },
});

/** Called by main.ts after the AI page containers are built. */
export const enterAiPage = () => page.enter();

/** Tear down live connections when leaving the AI page. */
export const leaveAiPage = () => page.leave();

export const handleAiPageEvent = (gesture: GESTURE_EVENTS) =>
    page.handleGesture(gesture);
