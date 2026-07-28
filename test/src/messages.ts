// Messages from the camera web app, and the canned replies that go back.
//
// TWO THINGS LIVE HERE, and only one of them is a page:
//
//   the stream   opened once at start-up and never closed. Every other stream
//                in this app belongs to a page and dies when you walk off it
//                (see docPage.ts) — this one has to outlive navigation, because
//                a message has to reach you on whichever page you are standing
//                on. That is the whole point.
//   the page     the log, reachable from the Msgs tile, plus the reply picker.
//
// WHY AN ARRIVING MESSAGE TAKES THE SCREEN RATHER THAN FLOATING OVER IT. A
// banner would have to be a text container, text containers are transparent,
// and on a document page all four image containers are already holding the
// document — so there is no layer to slide a dark box underneath (the same
// problem menu.ts solves with a backdrop, and the server solves by baking
// HUD_FEEDBACK into the tiles). Reserving a third rect would put a permanent
// hole in every rendered document for something that is empty almost always.
// A brief full-screen takeover that hands the page back costs nothing when no
// message is arriving, which is the state the glasses are in nearly all of the
// time.

import { TextContainerUpgrade } from "@evenrealities/even_hub_sdk";
import { bannerMs, GESTURE_EVENTS, MESSAGES_ID, PAGES } from "./constants";
import { bridge, buildPage, navigate, navigateBack } from "./main";
import { GlobalState } from "./state";
import { appLog } from "./debug";
import { MARKDOWN_SERVER_URL } from "./constants";

export interface Message {
    id: number;
    body: string;
    direction: "out" | "in";
    created_at: number;
    seen_at: number | null;
}

export interface MessageStatus {
    connected: number;
    lastSeenAt: number;
    unseen: number;
    maxChars: number;
    quickReplies: string[];
}

let messages: Message[] = [];
let quickReplies: string[] = ["Yes", "No", "OK", "Busy", "Call me"];

/** What the page is showing. `banner` is the transient arrival takeover. */
type Mode = "log" | "banner" | "reply";
let mode: Mode = "log";
let active = false;

/** Where a banner came from, so it can be handed back. */
let returnTo: PAGES | null = null;
let bannerTimer: ReturnType<typeof setTimeout> | null = null;
let bannerQueue: Message[] = [];

/** Which reply the marker is on, in `reply` mode. */
let replyIndex = 0;
/** Scroll offset in `log` mode, in messages from the end. */
let logOffset = 0;
let sending = false;
let note = "";

const LOG_LINES = 7;

// ── the stream ──────────────────────────────────────────────────────────────

let source: EventSource | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startMessageStream(): void {
    if (source) return;
    try {
        source = new EventSource(`${MARKDOWN_SERVER_URL}/messages/events`);
    } catch (err) {
        appLog("Messages", "stream failed to open", err);
        return;
    }

    source.addEventListener("messages", (ev) => {
        try {
            const data = JSON.parse((ev as MessageEvent).data) as {
                messages: Message[];
                status: MessageStatus;
            };
            apply(data.messages, data.status);
        } catch (err) {
            appLog("Messages", "bad payload", err);
        }
    });

    // EventSource reconnects on its own; this is the fallback for a stream the
    // webview has quietly given up on, which on a phone that has been asleep is
    // the normal case rather than the exception.
    source.addEventListener("error", () => appLog("Messages", "stream error"));
    if (!pollTimer) pollTimer = setInterval(() => void refresh(), 60_000);
}

async function refresh(): Promise<void> {
    try {
        const res = await fetch(`${MARKDOWN_SERVER_URL}/messages`);
        if (!res.ok) return;
        const data = (await res.json()) as { messages: Message[]; status: MessageStatus };
        apply(data.messages, data.status);
    } catch {
        // Offline is the resting state of a phone in a pocket, not an event.
    }
}

function apply(next: Message[], status: MessageStatus): void {
    if (status?.quickReplies?.length) quickReplies = status.quickReplies;

    const unseen = next.filter((m) => m.direction === "out" && !m.seen_at);
    const known = new Set(messages.map((m) => m.id));
    const arrived = unseen.filter((m) => !known.has(m.id) || messages.length === 0);

    messages = next;
    GlobalState.unreadMessages = unseen.length;

    if (arrived.length) announce(unseen);
    else if (active) void paint();
    else if (GlobalState.currentPage === PAGES.DASHBOARD) {
        // The unread count is drawn into the Msgs tile, so the dashboard has to
        // be rebuilt for it to change — a tile's content is part of the page
        // definition, exactly as its border is (see changeFocusedItem).
        void buildPage(PAGES.DASHBOARD);
    }
}

// ── arrival ─────────────────────────────────────────────────────────────────

/**
 * Show what is unread, unless now is a bad time.
 *
 * The Camera page is the one exception, and it is not a style choice: that page
 * is live preview plus the scan controls, and taking the screen mid-aim would
 * both lose the frame you were lining up and put your next tap somewhere you
 * did not intend. Messages wait until you leave it. Everywhere else — reading a
 * solution, sitting on the dashboard — an interruption costs a glance.
 */
function announce(unseen: Message[]): void {
    if (!unseen.length) return;

    if (GlobalState.currentPage === PAGES.CAMERA) {
        bannerQueue = unseen;
        appLog("Messages", "held", unseen.length, "while on Camera");
        return;
    }

    bannerQueue = [];
    if (mode !== "banner") returnTo = GlobalState.currentPage;
    mode = "banner";
    logOffset = 0;

    if (GlobalState.currentPage !== PAGES.MESSAGES) navigate(PAGES.MESSAGES);
    else void paint();

    armBannerTimer(unseen);
    void ackSeen(unseen[unseen.length - 1]!.id);
}

/** Called when leaving the Camera page, so a held message isn't lost. */
export function flushHeldMessages(): void {
    if (bannerQueue.length) {
        const held = bannerQueue;
        bannerQueue = [];
        // Deferred: this runs from leaveCurrentPage(), mid-navigation, and
        // navigating again from inside that would race the page being built.
        setTimeout(() => announce(held), 400);
    }
}

function armBannerTimer(unseen: Message[]): void {
    clearBannerTimer();
    const longest = unseen.reduce((n, m) => Math.max(n, m.body.length), 0);
    bannerTimer = setTimeout(() => {
        bannerTimer = null;
        if (mode === "banner") dismissBanner();
    }, bannerMs("x".repeat(longest)));
}

function clearBannerTimer(): void {
    if (bannerTimer) {
        clearTimeout(bannerTimer);
        bannerTimer = null;
    }
}

function dismissBanner(): void {
    clearBannerTimer();
    mode = "log";
    const back = returnTo;
    returnTo = null;
    // Back to what you were doing, not to the dashboard: the message
    // interrupted you, so it should put you back where it found you.
    if (back !== null && back !== PAGES.MESSAGES) navigate(back);
    else void paint();
}

async function ackSeen(id: number): Promise<void> {
    try {
        await fetch(`${MARKDOWN_SERVER_URL}/messages/seen`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id }),
        });
    } catch (err) {
        appLog("Messages", "seen ack failed", err);
    }
}

async function sendReply(text: string): Promise<void> {
    if (sending) return;
    sending = true;
    note = `Sending ${text}...`;
    void paint();
    try {
        const res = await fetch(`${MARKDOWN_SERVER_URL}/messages/reply`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
        });
        note = res.ok ? `Sent: ${text}` : `Failed (${res.status})`;
    } catch {
        note = "Failed - server unreachable";
    } finally {
        sending = false;
        void paint();
        // Long enough to read the confirmation, then out of the way: back to
        // whatever the message interrupted, or to the log if you came here
        // yourself. Guarded on still being in `reply` — a second message can
        // arrive inside this window and it owns the screen now, not this.
        setTimeout(() => {
            if (mode !== "reply") return;
            note = "";
            if (returnTo !== null) {
                dismissBanner();
            } else {
                mode = "log";
                void paint();
            }
        }, 1500);
    }
}

// ── drawing ─────────────────────────────────────────────────────────────────

function ago(ms: number): string {
    const mins = Math.round((Date.now() - ms) / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.round(hrs / 24)}d`;
}

/** Wrap to the panel: ~48 characters at body size across 576px. */
function wrap(text: string, width = 48): string[] {
    const out: string[] = [];
    for (const paragraph of text.split("\n")) {
        let line = "";
        for (const word of paragraph.split(/\s+/).filter(Boolean)) {
            if (!line) line = word;
            else if (line.length + 1 + word.length <= width) line += ` ${word}`;
            else {
                out.push(line);
                line = word;
            }
        }
        out.push(line);
    }
    return out.length ? out : [""];
}

function bannerBody(): string {
    const unseen = messages.filter((m) => m.direction === "out");
    const latest = unseen.slice(-2);
    const lines: string[] = ["NEW MESSAGE", ""];
    for (const m of latest) lines.push(...wrap(m.body), "");
    lines.push("Tap to reply   Double-tap to dismiss");
    return lines.join("\n");
}

function replyBody(): string {
    const lines: string[] = ["REPLY", ""];
    quickReplies.forEach((label, i) => {
        // ASCII only: the panel font has no glyph for the arrow you would reach
        // for first, and a missing glyph draws NOTHING rather than a box.
        lines.push(`${i === replyIndex ? "> " : "  "}${label}`);
    });
    lines.push("", note || "Swipe to choose, tap to send");
    return lines.join("\n");
}

function logBody(): string {
    if (!messages.length) {
        return ["MESSAGES", "", "Nothing yet.", "", "Sent from cam.aansl.com."].join("\n");
    }

    const rendered: string[] = [];
    for (const m of messages) {
        const who = m.direction === "out" ? "" : "> ";
        for (const line of wrap(`${who}${m.body}`, 44)) rendered.push(line);
        rendered[rendered.length - 1] += `  (${ago(m.created_at)})`;
    }

    // Paged from the end: the newest message is what you opened this for.
    const end = Math.max(0, rendered.length - logOffset);
    const start = Math.max(0, end - LOG_LINES);
    const window = rendered.slice(start, end);
    const more = start > 0 ? ` (${start} older)` : "";

    return [`MESSAGES${more}`, "", ...window, "", note || "Tap to reply"].join("\n");
}

let shown = "";

async function paint(): Promise<void> {
    if (!active) return;
    const content =
        mode === "banner" ? bannerBody() : mode === "reply" ? replyBody() : logBody();
    if (content === shown) return;
    shown = content;
    try {
        await bridge.textContainerUpgrade(
            new TextContainerUpgrade({
                containerID: MESSAGES_ID,
                containerName: "messages",
                content,
            }),
        );
    } catch (err) {
        appLog("Messages", "repaint failed", err);
    }
}

// ── the page ────────────────────────────────────────────────────────────────

export async function enterMessagesPage(): Promise<void> {
    active = true;
    shown = "";
    if (mode !== "banner") {
        mode = "log";
        logOffset = 0;
    }
    note = "";
    await paint();

    // Opening the log is as good an acknowledgement as the banner is.
    const newest = messages.filter((m) => m.direction === "out" && !m.seen_at).pop();
    if (newest) void ackSeen(newest.id);
    void refresh();
}

export function leaveMessagesPage(): void {
    active = false;
    clearBannerTimer();
    mode = "log";
    returnTo = null;
    note = "";
}

export function handleMessagesPageEvent(gesture: GESTURE_EVENTS): void {
    switch (mode) {
        case "banner":
            if (gesture === GESTURE_EVENTS.TAP) {
                // A reply is worth more than the countdown: stop it, or the
                // picker vanishes underneath you halfway through choosing.
                clearBannerTimer();
                mode = "reply";
                replyIndex = 0;
                void paint();
            } else if (gesture === GESTURE_EVENTS.DOUBLE_TAP) {
                dismissBanner();
            }
            break;

        case "reply":
            if (gesture === GESTURE_EVENTS.TAP) {
                void sendReply(quickReplies[replyIndex]!);
            } else if (gesture === GESTURE_EVENTS.SWIPE_DOWN) {
                replyIndex = (replyIndex + 1) % quickReplies.length;
                void paint();
            } else if (gesture === GESTURE_EVENTS.SWIPE_UP) {
                replyIndex = (replyIndex - 1 + quickReplies.length) % quickReplies.length;
                void paint();
            } else if (gesture === GESTURE_EVENTS.DOUBLE_TAP) {
                mode = returnTo !== null ? "banner" : "log";
                note = "";
                void paint();
            }
            break;

        default:
            if (gesture === GESTURE_EVENTS.TAP) {
                mode = "reply";
                replyIndex = 0;
                note = "";
                void paint();
            } else if (gesture === GESTURE_EVENTS.SWIPE_UP) {
                logOffset += LOG_LINES;
                void paint();
            } else if (gesture === GESTURE_EVENTS.SWIPE_DOWN) {
                logOffset = Math.max(0, logOffset - LOG_LINES);
                void paint();
            } else if (gesture === GESTURE_EVENTS.DOUBLE_TAP) {
                navigateBack();
            }
            break;
    }
}
