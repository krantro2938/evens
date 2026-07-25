// The Assignment page: whatever the lookcam reader has transcribed off the
// paper so far, re-rendered as it fills in, plus a corner box that carries the
// model's camera advice and doubles as the start/stop control.
//
// Same document machinery as the AI page (docPage.ts); the differences are the
// endpoint, a `status` SSE listener, and a tap that acts instead of paging.

import { TextContainerUpgrade } from "@evenrealities/even_hub_sdk";
import {
    DOC_BASE_ASSIGNMENT,
    DOC_FEEDBACK_ID,
    GESTURE_EVENTS,
    MARKDOWN_SERVER_URL,
} from "./constants";
import { GlobalState, type AssignmentStatus, type DocState } from "./state";
import { createDocPage } from "./docPage";
import { bridge } from "./main";
import { appLog } from "./debug";

// A toggle takes a round trip to the reader; ignore taps until it lands so an
// impatient double-press can't start and immediately stop a job.
let toggleInFlight = false;

function status(): AssignmentStatus | null {
    return GlobalState.assignmentStatus;
}

/** One line for the pager: where we are in the document, or why we aren't. */
function pagerLabel(state: DocState): string {
    const s = status();
    if (s && s.upstream !== "open") return `Reader ${s.upstream}`;
    if (!state.pages.length) return s?.running ? "Reading the page…" : state.status;
    const pages = `${state.currentPage + 1} / ${state.pages.length}`;
    return s?.running ? `${pages}  ·  capture ${s.captures}` : pages;
}

/**
 * The corner box. It is always on screen — border width is part of the page
 * definition and can't be upgraded, so a box that appeared and disappeared
 * would need a full page rebuild (and a re-push of all four tiles) every time
 * a job started. Instead it always shows the most useful thing available:
 * camera advice while capturing, otherwise what a tap will do.
 */
function feedbackText(): string {
    const s = status();
    if (!s) return "Connecting…";
    if (s.upstream === "disabled") return "No reader configured";
    if (s.upstream !== "open") return `Reader ${s.upstream}\n${s.error ?? ""}`.trim();

    if (s.running) {
        const f = s.feedback;
        if (!f) return `Capture ${s.captures}…\nTap to stop`;
        // advice_detail is a full sentence; camera_advice is the enum. Lead with
        // the enum so the useful word survives even if the box clips.
        const head = f.camera_advice && f.camera_advice !== "ok" ? `▲ ${f.camera_advice}` : "✓ framing ok";
        return `${head}\n${f.advice_detail}`;
    }

    if (s.done) return `Done · ${s.problems} problems\nTap to rescan`;
    if (s.error) return `Failed: ${s.error}\nTap to retry`;
    if (s.reason === "max_captures") return "Hit capture limit\nTap to rescan";
    if (s.reason === "stopped") return `Stopped at ${s.captures}\nTap to resume`;
    return "Tap to start reading";
}

const page = createDocPage({
    name: "Assignment",
    base: DOC_BASE_ASSIGNMENT,
    state: GlobalState.assignmentState,
    // Swipes page through the document; tap is the start/stop button.
    tapAction: "action",
    onPrimaryAction: () => void toggle(),
    pagerLabel,
    events: {
        status: (data) => {
            GlobalState.assignmentStatus = data as AssignmentStatus;
            // Status moves far more often than the document does, so this only
            // touches the two text containers — never the image tiles.
            page.enqueue(async () => {
                await updateFeedback();
                await page.updatePager();
            });
        },
    },
    // Tiles land on their own schedule; keep the box in step with them.
    afterShow: () => updateFeedback(),
});

async function updateFeedback(): Promise<void> {
    await bridgeUpgrade(DOC_FEEDBACK_ID, "feedback", feedbackText());
}

async function bridgeUpgrade(id: number, name: string, content: string): Promise<void> {
    await bridge.textContainerUpgrade(
        new TextContainerUpgrade({
            containerID: id,
            containerName: name,
            content,
        }),
    );
}

/**
 * Start, stop, or reset+restart — the server decides which from live job state
 * (see server/assignment.ts), so the glasses only ever send one thing.
 */
async function toggle(): Promise<void> {
    if (toggleInFlight) return;
    toggleInFlight = true;
    page.enqueue(() => bridgeUpgrade(DOC_FEEDBACK_ID, "feedback", "Working…"));
    try {
        const res = await fetch(`${MARKDOWN_SERVER_URL}${DOC_BASE_ASSIGNMENT}/toggle`, {
            method: "POST",
        });
        const body = (await res.json()) as { ok: boolean; action: string; detail?: string };
        appLog("Assignment toggle", body.action, body.detail ?? "");
        if (!body.ok) {
            page.enqueue(() =>
                bridgeUpgrade(
                    DOC_FEEDBACK_ID,
                    "feedback",
                    `Couldn't ${body.action === "failed" ? "start" : body.action}\n${body.detail ?? ""}`.trim(),
                ),
            );
        }
    } catch (err) {
        appLog("Assignment toggle failed", err);
        page.enqueue(() =>
            bridgeUpgrade(DOC_FEEDBACK_ID, "feedback", "Server unreachable\nTap to retry"),
        );
    } finally {
        toggleInFlight = false;
        // The reader's next `status` event repaints the box with the truth.
    }
}

/** Called by main.ts after the assignment page containers are built. */
export async function enterAssignmentPage(): Promise<void> {
    await page.enter();
    page.enqueue(updateFeedback);
}

/** Tear down live connections when leaving the page. */
export const leaveAssignmentPage = () => page.leave();

export const handleAssignmentPageEvent = (gesture: GESTURE_EVENTS) =>
    page.handleGesture(gesture);
