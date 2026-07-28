// The Settings page: publish the photo you just took as the assignment.
//
// WHAT IT IS FOR. Aiming the fixed camera at a sheet is the slow way to scan
// one. Shooting it with the phone is the fast way, and until now there was no
// path from a phone photo to the reader — so this page is that path, reduced to
// a single temple tap: shoot the paper, look up, tap.
//
// The photo comes from the gallery bridge (see gallery.ts): the companion app
// is configured with its URL once, and this page uses the same setting, because
// they are the same web app on the same phone.
//
// IT IS DESTRUCTIVE, AND THAT SHAPES THE WHOLE PAGE. Publishing archives the
// current assignment and starts a new one from the photo — a photo is a
// different sheet, and merging it into a half-built transcription would
// interleave two papers. So a tap does not publish. The first tap ARMS, naming
// the photo it is about to use and how old it is; the second commits. That is
// the difference between "publish what I just shot" and "throw away a scan I
// spent two minutes on because my temple brushed something".

import { TextContainerUpgrade } from "@evenrealities/even_hub_sdk";
import { GESTURE_EVENTS, SETTINGS_ID } from "./constants";
import { bridge, navigateBack } from "./main";
import { appLog } from "./debug";
import {
    checkBridge,
    getBridge,
    latestPhoto,
    publishLatestFromGallery,
    type PhotoMeta,
} from "./gallery";
import { ago } from "./utils";

type Phase =
    /** Looking for the bridge, or for a photo in it. */
    | "checking"
    /** A photo is ready and named; a tap arms. */
    | "ready"
    /** Armed: the next tap publishes. */
    | "armed"
    /** Uploading and waiting for the model. */
    | "working"
    /** Finished, or failed, with something to say about it. */
    | "done"
    | "error";

let active = false;
let phase: Phase = "checking";
let photo: PhotoMeta | null = null;
let message = "";
let ticker: ReturnType<typeof setInterval> | null = null;

/**
 * How long an armed tap stays armed.
 *
 * The confirmation is only meaningful if it expires: an armed page left on your
 * face turns the NEXT stray tap — minutes later, about something else — into
 * the destructive one, which is precisely the accident the arming exists to
 * prevent.
 */
const ARM_TIMEOUT_MS = 10_000;
let armedAt = 0;

// ── text ────────────────────────────────────────────────────────────────────

const HEADING = "SETTINGS - publish a photo";

function body(): string {
    const lines: string[] = [HEADING, ""];

    switch (phase) {
        case "checking":
            lines.push(message || "Looking for the phone's gallery...");
            break;

        case "ready":
            lines.push(`Latest photo: ${photo?.name ?? "?"}`);
            lines.push(photo ? `Taken ${ago(photo.taken_at)}` : "");
            lines.push("");
            lines.push("Tap to publish it as the assignment");
            break;

        case "armed": {
            const left = Math.max(0, Math.ceil((ARM_TIMEOUT_MS - (Date.now() - armedAt)) / 1000));
            lines.push(`Publish ${photo?.name ?? "this photo"}?`);
            lines.push("This REPLACES the current assignment.");
            lines.push("");
            lines.push(`Tap again to confirm (${left}s)`);
            break;
        }

        case "working":
            lines.push(message || "Publishing...");
            lines.push("The reader is transcribing it.");
            break;

        case "done":
            lines.push(message);
            lines.push("");
            lines.push("Tap to publish another");
            break;

        case "error":
            lines.push(message);
            lines.push("");
            lines.push("Tap to try again");
            break;
    }

    lines.push("");
    lines.push("Double tap to go back");
    return lines.filter((line, i) => line !== "" || i === 0 || lines[i - 1] !== "").join("\n");
}

let shown = "";

async function repaint(): Promise<void> {
    if (!active) return;
    const content = body();
    if (content === shown) return;
    shown = content;
    try {
        await bridge.textContainerUpgrade(
            new TextContainerUpgrade({
                containerID: SETTINGS_ID,
                containerName: "settings",
                content,
            }),
        );
    } catch (err) {
        appLog("Settings", "repaint failed", err);
    }
}

/** Only while armed: the countdown is the one thing that moves on its own. */
function syncTicker(): void {
    const moving = active && phase === "armed";
    if (moving && !ticker) {
        ticker = setInterval(() => {
            if (Date.now() - armedAt >= ARM_TIMEOUT_MS) {
                // Disarmed rather than published: an expired confirmation is a
                // confirmation you did not give.
                phase = photo ? "ready" : "checking";
                syncTicker();
            }
            void repaint();
        }, 1_000);
    } else if (!moving && ticker) {
        clearInterval(ticker);
        ticker = null;
    }
}

// ── the gallery ─────────────────────────────────────────────────────────────

async function findPhoto(): Promise<void> {
    phase = "checking";
    photo = null;
    message = "Looking for the phone's gallery...";
    void repaint();

    if (!getBridge()) {
        phase = "error";
        // Said in full: this page is the first place anyone meets the bridge,
        // and "not configured" with no idea where to configure it is a dead end.
        message = "No gallery bridge. Set it up in the companion app's Photo tab.";
        return void repaint();
    }

    const health = await checkBridge();
    if (!health.ok) {
        phase = "error";
        message = `Gallery bridge unreachable: ${health.detail ?? "no answer"}`;
        return void repaint();
    }

    try {
        photo = await latestPhoto();
        phase = "ready";
    } catch (err) {
        phase = "error";
        message = err instanceof Error ? err.message : String(err);
    }
    void repaint();
}

async function publish(): Promise<void> {
    phase = "working";
    message = `Publishing ${photo?.name ?? "photo"}...`;
    syncTicker();
    void repaint();

    // The photo this page NAMED, not whatever is newest by the time the
    // confirmation lands — see publishLatestFromGallery.
    const result = await publishLatestFromGallery(photo ?? undefined);
    if (!active) return;

    if (result.ok) {
        phase = "done";
        const count = result.problems ?? 0;
        message = `Published - ${count} problem${count === 1 ? "" : "s"} read`;
    } else {
        phase = "error";
        message = `Failed: ${result.detail ?? "unknown error"}`;
    }
    void repaint();
}

// ── lifecycle ───────────────────────────────────────────────────────────────

export async function enterSettingsPage(): Promise<void> {
    active = true;
    phase = "checking";
    photo = null;
    message = "";
    armedAt = 0;
    // The container is brand new and blank; without this the dedup below would
    // compare against what the last visit left on screen and write nothing.
    shown = "";
    syncTicker();
    await repaint();
    void findPhoto();
}

export function leaveSettingsPage(): void {
    active = false;
    phase = "checking";
    armedAt = 0;
    syncTicker();
}

export function handleSettingsPageEvent(gesture: GESTURE_EVENTS): void {
    if (gesture === GESTURE_EVENTS.DOUBLE_TAP) return navigateBack();

    // Swipes do nothing here on purpose. There is one action on this page and it
    // is destructive; a page where every gesture does something is a page where
    // an accidental gesture does something.
    if (gesture !== GESTURE_EVENTS.TAP) return;

    switch (phase) {
        case "working":
            return; // a second tap must not start a second upload

        case "ready":
            phase = "armed";
            armedAt = Date.now();
            syncTicker();
            void repaint();
            return;

        case "armed":
            if (Date.now() - armedAt > ARM_TIMEOUT_MS) {
                // Expired between the tick and the tap: treat it as arming
                // afresh rather than publishing on a stale confirmation.
                armedAt = Date.now();
                void repaint();
                return;
            }
            phase = "working";
            syncTicker();
            void publish();
            return;

        // done / error / checking: a tap re-reads the gallery, which is also how
        // you pick up the photo you took while looking at this page.
        default:
            void findPhoto();
    }
}
