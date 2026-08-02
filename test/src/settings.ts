// The Setup page: the two things you can do to the app from your face.
//
// PUBLISH A PHOTO. Aiming the fixed camera at a sheet is the slow way to scan
// one. Shooting it with the phone is the fast way, and until now there was no
// path from a phone photo to the reader — so this action is that path, reduced
// to a single temple tap: shoot the paper, look up, tap.
//
// The photo comes from the gallery bridge (see gallery.ts): the companion app
// is configured with its URL once, and this page uses the same setting, because
// they are the same web app on the same phone.
//
// It ADDS TO the assignment rather than replacing it. A sheet too big to fit one
// readable frame is read as several photos of it, and each one is merged into
// the same transcription exactly as a camera frame is — so shoot the top,
// publish, shoot the bottom, publish. (Starting a NEW assignment from a photo is
// the companion app's Photo tab, where there is a screen to warn on.)
//
// RESTART THE APP. The failure this exists for is a document page that renders
// perfectly and never reaches the glasses: every tile push comes back
// `sendFailed`, the pager keeps updating over a blank panel and the footer says
// "Glasses link error - tiles not sent" (see render/tilePush.ts and docPage.ts).
// It sets in after the app has been up a while, and closing and reopening the
// app in the Even Realities app clears it every time — so the remedy is a
// restart, and until now the restart needed the phone in your hand.
//
// A TAP STILL DOES NOT ACT. The first tap ARMS, naming what it is about to do;
// the second commits. Both actions are expensive to take back — one spends a
// model call on a slow round trip, the other blanks the screen for several
// seconds — and a temple that brushes something should not start either.

import { TextContainerUpgrade } from "@evenrealities/even_hub_sdk";
import { GESTURE_EVENTS, SETTINGS_ID } from "./constants";
import { bridge, navigateBack } from "./main";
import { appLog, flushLog } from "./debug";
import {
    checkBridge,
    getBridge,
    latestPhoto,
    publishLatestFromGallery,
    type PhotoMeta,
} from "./gallery";
import { ago } from "./utils";
import { serverUrl, getMode, setMode, type Mode } from "./services/backend";

/** The actions, in the order the list draws them. */
const ACTIONS = ["photo", "mode", "restart"] as const;
type Action = (typeof ACTIONS)[number];

const MODE_CYCLE: Mode[] = ["auto", "online", "offline"];

const LABELS: Record<Action, string> = {
    photo: "Publish photo",
    mode: "Mode: auto",
    restart: "Restart app",
};

/**
 * Where the photo action is up to. The restart action has no phase of its own:
 * it is armed, and then the app is gone.
 */
type PhotoPhase =
    /** Looking for the bridge, or for a photo in it. */
    | "checking"
    /** A photo is ready and named; a tap arms. */
    | "ready"
    /** Uploading and waiting for the model. */
    | "working"
    /** Finished, or failed, with something to say about it. */
    | "done"
    | "error";

let active = false;
let focus = 0;
let phase: PhotoPhase = "checking";
let photo: PhotoMeta | null = null;
let message = "";
let ticker: ReturnType<typeof setInterval> | null = null;

/** Set once the reload is committed to, so the last repaint says why. */
let restarting = false;

/**
 * How long an armed tap stays armed.
 *
 * The confirmation is only meaningful if it expires: an armed page left on your
 * face turns the NEXT stray tap — minutes later, about something else — into
 * the destructive one, which is precisely the accident the arming exists to
 * prevent.
 */
const ARM_TIMEOUT_MS = 10_000;
let armed: Action | null = null;
let armedAt = 0;

const focused = (): Action => ACTIONS[focus];

// ── text ────────────────────────────────────────────────────────────────────
//
// THE WHOLE PAGE IS A LINE BUDGET. The container is BODY_H tall with
// CONTAINER_PAD above and below, so nine LINE_HEIGHT rows fit and a tenth does
// not — and content taller than its container gets a SCROLLER attached by the
// host (see constants.ts), which would then eat the swipes that move the cursor
// on the one page whose cursor is the only way to reach the second action.
//
// That is why there is one blank line in the layout rather than three, why the
// two hints share a row, and why a message from the gallery is clamped: it
// arrives from a server and is the one string here nobody wrote to fit.

const HEADING = "SETUP";

/** Both hints on one row, because the tenth line is the one that breaks. */
const HINTS = "Swipe to choose - double tap to go back";

/** Roughly two rendered lines at ~12px a lowercase character across 556px. */
const MESSAGE_MAX = 88;

const clamp = (text: string): string =>
    text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX - 1)}...` : text;

/** The list, with a cursor on the focused row. */
function menu(): string[] {
    return ACTIONS.map((action, index) => `${index === focus ? ">" : " "} ${LABELS[action]}`);
}

/**
 * What the focused action is about, under the list rather than beside it.
 *
 * Beside it was the first shape and it does not survive contact with the
 * strings: a bridge that isn't configured has a whole sentence to say about it,
 * and a row that wraps drags the cursor column apart.
 */
function detail(): string[] {
    if (focused() === "restart") {
        return [
            "Reloads the app on the glasses.",
            // A reload drops the upload with it. Said on the row you are
            // deciding about, not only on the confirmation, because a publish
            // takes long enough to have walked away from.
            phase === "working"
                ? "This cancels the publish in progress."
                : "For tiles that stopped arriving.",
            "Tap to restart",
        ];
    }

    if (focused() === "mode") {
        const descriptions: Record<Mode, string> = {
            auto: "Cloud when online, local when not.",
            online: "Always use the cloud solver.",
            offline: "Always use the local solver.",
        };
        return [descriptions[getMode()], "Tap to cycle modes"];
    }

    switch (phase) {
        case "checking":
            return [clamp(message || "Looking for the phone's gallery...")];

        case "ready":
            return [
                photo ? `${photo.name} - ${ago(photo.taken_at)}` : "No photo yet",
                "Tap to add it to the assignment",
            ];

        case "working":
            return [clamp(message || "Publishing..."), "The reader is transcribing it."];

        case "done":
            return [clamp(message), "Tap to publish another"];

        case "error":
            return [clamp(message), "Tap to try again"];
    }
}

/** The armed screen: one question, and the countdown that answers it for you. */
function confirmation(action: Action): string[] {
    const left = Math.max(0, Math.ceil((ARM_TIMEOUT_MS - (Date.now() - armedAt)) / 1000));
    const question =
        action === "restart"
            ? ["Restart the app?", "The screen goes dark for a few seconds."]
            : [
                  `Publish ${photo?.name ?? "this photo"}?`,
                  "It is READ INTO the current assignment.",
              ];
    return [...question, "", `Tap again to confirm (${left}s)`];
}

function body(): string {
    // Nothing to go back to mid-reload, and nothing left to do it with — so
    // that state is the only one without a hint row. The other two spend their
    // ninth line on it.
    const lines: string[] = [HEADING];

    if (restarting) {
        lines.push("", "Restarting...", "The dashboard comes back on its own.");
    } else if (armed) {
        // No list while armed: the question is the page, and a cursor next to
        // it invites the swipe that throws the confirmation away.
        lines.push("", ...confirmation(armed), "", "Double tap to go back");
    } else {
        lines.push(...menu(), "", ...detail(), "", HINTS);
    }

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
    const moving = active && armed !== null;
    if (moving && !ticker) {
        ticker = setInterval(() => {
            if (Date.now() - armedAt >= ARM_TIMEOUT_MS) {
                // Disarmed rather than acted on: an expired confirmation is a
                // confirmation you did not give.
                armed = null;
                syncTicker();
            }
            void repaint();
        }, 1_000);
    } else if (!moving && ticker) {
        clearInterval(ticker);
        ticker = null;
    }
}

function arm(action: Action): void {
    armed = action;
    armedAt = Date.now();
    syncTicker();
    void repaint();
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

// ── the restart ─────────────────────────────────────────────────────────────

/**
 * Reload the WebView, which is as close to "close it and open it again" as the
 * app can get to itself.
 *
 * A reload re-runs main.ts from the top: a fresh bridge handshake, a fresh
 * start-up page, and every module's state back to its initial value — the tile
 * pusher's dedup cache and the document pages' `linkError` included. What it
 * does NOT do is restart the host app on the phone, so if the link is wedged
 * somewhere below the WebView this will not fix it; quitting (double tap on the
 * dashboard) and relaunching from the phone is the next thing to try.
 *
 * The two awaits are the point of the delay. The panel is painted BEFORE the
 * reload because a page that goes blank with no explanation looks like the
 * crash this is meant to fix, and the log is flushed because the lines saying
 * an operator asked for a restart are exactly the ones the 1.5s batch timer
 * would drop on the way out.
 */
async function restart(): Promise<void> {
    restarting = true;
    armed = null;
    syncTicker();
    appLog("Settings", "restart requested - reloading the app");
    await repaint();
    await flushLog();
    location.reload();
}

// ── lifecycle ───────────────────────────────────────────────────────────────

export async function enterSettingsPage(): Promise<void> {
    active = true;
    focus = 0;
    phase = "checking";
    photo = null;
    message = "";
    armed = null;
    armedAt = 0;
    restarting = false;
    // The container is brand new and blank; without this the dedup below would
    // compare against what the last visit left on screen and write nothing.
    shown = "";
    syncTicker();
    await repaint();
    void findPhoto();
    void loadModeFromServer();
}

export function leaveSettingsPage(): void {
    active = false;
    phase = "checking";
    armed = null;
    armedAt = 0;
    syncTicker();
}

export function handleSettingsPageEvent(gesture: GESTURE_EVENTS): void {
    // The app is on its way out; nothing here can outlive the reload.
    if (restarting) return;

    if (gesture === GESTURE_EVENTS.DOUBLE_TAP) return navigateBack();

    // Swipes move the cursor and nothing else. They also DISARM: a confirmation
    // is about one action, and carrying it to the row you just swiped onto is
    // how you restart the app while trying to publish a photo.
    if (gesture === GESTURE_EVENTS.SWIPE_UP || gesture === GESTURE_EVENTS.SWIPE_DOWN) {
        const step = gesture === GESTURE_EVENTS.SWIPE_UP ? -1 : 1;
        focus = (focus + step + ACTIONS.length) % ACTIONS.length;
        armed = null;
        syncTicker();
        return void repaint();
    }

    if (gesture !== GESTURE_EVENTS.TAP) return;

    if (armed) {
        if (Date.now() - armedAt > ARM_TIMEOUT_MS) {
            // Expired between the tick and the tap: treat it as arming afresh
            // rather than acting on a stale confirmation.
            return arm(armed);
        }
        const action = armed;
        armed = null;
        syncTicker();
        if (action === "restart") return void restart();
        return void publish();
    }

    if (focused() === "restart") return arm("restart");

    if (focused() === "mode") return void cycleMode();

    switch (phase) {
        case "working":
            return; // a second tap must not start a second upload

        case "ready":
            return arm("photo");

        // done / error / checking: a tap re-reads the gallery, which is also how
        // you pick up the photo you took while looking at this page.
        default:
            void findPhoto();
    }
}

async function cycleMode(): Promise<void> {
    const idx = MODE_CYCLE.indexOf(getMode());
    const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
    setMode(next);
    LABELS.mode = `Mode: ${next}`;
    void repaint();
}

async function loadModeFromServer(): Promise<void> {
    LABELS.mode = `Mode: ${getMode()}`;
    try {
        const res = await fetch(`${serverUrl()}/settings/mode`);
        const data = await res.json();
        const v = data?.value;
        if (v === "online" || v === "offline" || v === "auto") {
            setMode(v);
            LABELS.mode = `Mode: ${v}`;
        }
    } catch {}
}
