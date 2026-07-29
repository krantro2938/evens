// Messages from the camera web app, and the canned replies that go back.
//
// TWO THINGS LIVE HERE, and only one of them is a page:
//
//   the stream   opened once at start-up and never closed. Every other stream
//                in this app belongs to a page and dies when you walk off it
//                (see docPage.ts) — this one has to outlive navigation, because
//                a message has to reach you on whichever page you are standing
//                on. That is the whole point.
//   the page     the conversation, reachable from the Msgs tile, plus the
//                reply picker.
//
// ONE CONTAINER PER MESSAGE. A text container draws a box — borderWidth and
// borderRadius, exactly as the dashboard tiles do — and it sits at whatever
// x/y you build it at. So a bubble is just a container sized to its own text
// and pushed against one edge: theirs on the left, yours on the right. The side
// is the whole distinction, because a text container is transparent and there
// is no fill to tell them apart with.
//
// WHY THE PAGE REBUILDS RATHER THAN REPAINTS. Geometry is fixed when a
// container is built. A message that arrives is a different set of boxes in
// different places, so it is a new page, not new text in the old one. That is
// affordable precisely because this page is all text: `rebuildPageContainer` is
// one call with no image payload, unlike a document page where the same rebuild
// drags four tiles back over BLE.
//
// AND NOTHING SCROLLS. The host attaches a scroller to any text container
// holding more lines than it is tall, and that scroller then owns the swipes —
// which is what made the old single-container log slide around under a gesture
// meant to move the reply marker, and pushed the hint off the bottom of the
// panel. Every box here is built tall enough for the text that goes in it, and
// the wrap that decides how many lines that is uses the same width estimate the
// box was sized from (see textWidth). Nothing overflows, so nothing scrolls.

import { RebuildPageContainer, TextContainerProperty, TextContainerUpgrade } from "@evenrealities/even_hub_sdk";
import {
    bannerMs,
    BODY_H,
    BODY_W,
    BUBBLE_BORDER,
    BUBBLE_EDGE,
    BUBBLE_GAP,
    BUBBLE_LINE_H,
    BUBBLE_MAX_W,
    BUBBLE_MIN_W,
    BUBBLE_PAD,
    BUBBLE_RADIUS,
    CONTAINER_PAD,
    DEFAULT_COLOR,
    FOCUSED_COLOR,
    GESTURE_EVENTS,
    MARKDOWN_SERVER_URL,
    MENU_W,
    MENU_X,
    MSG_BUBBLE_IDS,
    MSG_EVENT_ID,
    MSG_FLOOR,
    MSG_HINT_H,
    MSG_HINT_ID,
    MSG_HINT_Y,
    MSG_MAX_BUBBLES,
    MSG_REPLY_ID,
    PAGES,
    Z_BACKDROP,
    Z_BUBBLE_BASE,
    Z_HINT,
    Z_REPLY,
    zOrder,
} from "./constants";
import { bridge, buildPage, navigate, navigateBack } from "./main";
import { GlobalState } from "./state";
import { appLog } from "./debug";

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
type Mode = "chat" | "banner" | "reply";
let mode: Mode = "chat";
let active = false;

/** Where a banner came from, so it can be handed back. */
let returnTo: PAGES | null = null;
let bannerTimer: ReturnType<typeof setTimeout> | null = null;
let bannerQueue: Message[] = [];

/** Which reply the marker is on, in `reply` mode. */
let replyIndex = 0;
/**
 * How many of the newest messages are scrolled past.
 *
 * Counted in MESSAGES, not lines or pages: a chat scrolls by what was said,
 * and one message per swipe means the thing you were reading is still on
 * screen after it moves.
 */
let scrollBack = 0;
let sending = false;
let note = "";

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
    const grew = next.length !== messages.length;

    messages = next;
    GlobalState.unreadMessages = unseen.length;

    if (arrived.length) {
        announce(unseen);
    } else if (active && mode !== "reply") {
        // Back to the bottom on a change: the new message is there, and a
        // scroll position counted from the end means something different once
        // the end has moved.
        if (grew) scrollBack = 0;
        void rebuild();
    } else if (GlobalState.currentPage === PAGES.DASHBOARD) {
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
    scrollBack = 0;

    if (GlobalState.currentPage !== PAGES.MESSAGES) navigate(PAGES.MESSAGES);
    else void rebuild();

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
    mode = "chat";
    const back = returnTo;
    returnTo = null;
    // Back to what you were doing, not to the dashboard: the message
    // interrupted you, so it should put you back where it found you.
    if (back !== null && back !== PAGES.MESSAGES) navigate(back);
    else void rebuild();
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
    void paintHint();
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
        void paintHint();
        // Long enough to read the confirmation, then out of the way: back to
        // whatever the message interrupted, or to the conversation — where the
        // reply is now a bubble on the right, which is the real confirmation.
        setTimeout(() => {
            if (mode !== "reply") return;
            note = "";
            if (returnTo !== null) {
                dismissBanner();
            } else {
                mode = "chat";
                scrollBack = 0;
                void rebuild();
            }
        }, 1500);
    }
}

// ── measuring text ──────────────────────────────────────────────────────────

/**
 * Roughly how wide `text` is on the panel, in pixels.
 *
 * An ESTIMATE, and it has to be: the panel font lives on the glasses, not in
 * this webview, so there is nothing here to ask. Measuring it with a canvas
 * would measure the phone's font instead and confidently return the wrong
 * number.
 *
 * Calibrated against the one figure this app already had — ~48 characters of
 * mixed-case text across 576px, from the old wrap() — and then split by
 * character class, because "iiiii" and "MMMMM" are not the same width in any
 * font a HUD would ship. Sizes derived from it all carry slack (see
 * BUBBLE_LINE_H): overestimating costs a few pixels of bubble, while
 * underestimating costs a line of text the box has no room for, which is a
 * scroller.
 */
const NARROW = new Set("iljtfI.,:;'`|!()[]{}/\\ ");
const WIDE = new Set("mwMW@%");
const UPPER = /[A-Z0-9]/;

export function textWidth(text: string): number {
    let w = 0;
    for (const ch of text) {
        if (NARROW.has(ch)) w += 7;
        else if (WIDE.has(ch)) w += 18;
        else if (UPPER.test(ch)) w += 14;
        else w += 12;
    }
    return w;
}

/** Wrap to a pixel width, breaking words that cannot fit on a line of their own. */
function wrapToWidth(text: string, maxWidth: number): string[] {
    const out: string[] = [];
    for (const paragraph of text.split("\n")) {
        let line = "";
        for (const word of paragraph.split(/\s+/).filter(Boolean)) {
            let rest = word;
            // A pasted link is one "word" and wider than the bubble. Break it
            // rather than let it hang over the edge and be re-wrapped by the
            // host into a line the box was never sized for.
            while (textWidth(rest) > maxWidth) {
                let cut = rest.length;
                while (cut > 1 && textWidth(rest.slice(0, cut)) > maxWidth) cut--;
                if (line) {
                    out.push(line);
                    line = "";
                }
                out.push(rest.slice(0, cut));
                rest = rest.slice(cut);
            }
            const candidate = line ? `${line} ${rest}` : rest;
            if (textWidth(candidate) <= maxWidth) line = candidate;
            else {
                if (line) out.push(line);
                line = rest;
            }
        }
        out.push(line);
    }
    return out.length ? out : [""];
}

// ── laying the conversation out ─────────────────────────────────────────────

interface Bubble {
    lines: string[];
    x: number;
    y: number;
    w: number;
    h: number;
    /** Yours, so the marker of who said it is which edge it hugs. */
    mine: boolean;
}

/** Inner width available to text inside a bubble of outer width `w`. */
function innerWidth(w: number): number {
    return w - 2 * (BUBBLE_PAD + BUBBLE_BORDER);
}

/**
 * End a line with "..." without making it wider than it was allowed to be.
 *
 * Appending the dots and hoping is what would break the box: three characters
 * past the width the bubble was built for, the host wraps the line, and the
 * bubble is one row short of its own contents — a scroller.
 */
function clip(line: string, maxWidth: number): string {
    let cut = line.length;
    while (cut > 0 && textWidth(`${line.slice(0, cut)}...`) > maxWidth) cut--;
    return `${line.slice(0, cut).trimEnd()}...`;
}

/**
 * One message as a box: wrapped to the widest it may be, then shrunk to fit
 * what the wrap actually used, so a short message gets a short bubble.
 */
function measure(m: Message): { lines: string[]; w: number; h: number } {
    const maxInner = innerWidth(BUBBLE_MAX_W);
    const lines = wrapToWidth(m.body, maxInner);
    const widest = lines.reduce((n, line) => Math.max(n, textWidth(line)), 0);
    // A little more than measured, because the measurement is a guess and the
    // direction that hurts is too narrow.
    const w = Math.max(
        BUBBLE_MIN_W,
        Math.min(BUBBLE_MAX_W, Math.ceil(widest * 1.06) + 2 * (BUBBLE_PAD + BUBBLE_BORDER) + 4),
    );
    const h = lines.length * BUBBLE_LINE_H + 2 * (BUBBLE_PAD + BUBBLE_BORDER);
    return { lines, w, h };
}

/**
 * The bubbles that fit, newest at the bottom.
 *
 * Built from the newest backwards and stacked upwards from the floor, which is
 * both how a chat reads and the only order in which "what fits" is answerable:
 * the message you must see is the last one, so it is the one that gets the
 * space first.
 */
function layout(): Bubble[] {
    const end = Math.max(0, messages.length - scrollBack);
    const bubbles: Bubble[] = [];
    let bottom = MSG_FLOOR;

    for (let i = end - 1; i >= 0 && bubbles.length < MSG_MAX_BUBBLES; i--) {
        const m = messages[i]!;
        let { lines, w, h } = measure(m);

        // A message taller than the whole panel. The server caps a send at 240
        // characters, which fits — but "does not fit" must not mean "is not
        // drawn", and it did: a single over-long message laid out to nothing
        // and left the page blank. So the newest one is clipped to the space
        // instead, because a message you can read most of beats a black screen.
        if (h > bottom && !bubbles.length) {
            const room = Math.max(1, Math.floor((bottom - 2 * (BUBBLE_PAD + BUBBLE_BORDER)) / BUBBLE_LINE_H));
            lines = lines.slice(0, room);
            lines[room - 1] = clip(lines[room - 1] ?? "", innerWidth(w));
            h = lines.length * BUBBLE_LINE_H + 2 * (BUBBLE_PAD + BUBBLE_BORDER);
        }

        const top = bottom - h;
        // Half a bubble hanging off the top of the panel is worse than one
        // fewer message: it reads as a rendering fault rather than as history.
        if (top < 0) break;

        // "out" arrives from the web app, so it is the other person; "in" is
        // what these glasses sent, so it is yours and it goes on the right.
        const mine = m.direction === "in";
        bubbles.push({
            lines,
            w,
            h,
            x: mine ? BODY_W - BUBBLE_EDGE - w : BUBBLE_EDGE,
            y: top,
            mine,
        });
        bottom = top - BUBBLE_GAP;
    }

    // Oldest first, so container ids run down the screen and a log line about
    // bubble 0 is about the top of the panel.
    return bubbles.reverse();
}

/** How far back the scroll can go before the oldest message is on screen. */
function maxScrollBack(): number {
    return Math.max(0, messages.length - 1);
}

// ── the hint strip ──────────────────────────────────────────────────────────

/**
 * One line under the conversation, and the only thing on this page that is
 * updated rather than rebuilt.
 *
 * It says what a gesture will do. Where you are in the scrollback belongs here
 * too rather than in a heading: a heading is a container, and a container is a
 * bubble's worth of panel spent on something that is only true while you are
 * swiping.
 */
function hintText(): string {
    if (note) return note;
    if (mode === "reply") return "Swipe to choose, tap to send, double-tap to go back";
    if (!messages.length) return "No messages yet - send one from cam.aansl.com";
    if (mode === "banner") return "NEW MESSAGE   Tap to reply   Double-tap to dismiss";
    if (scrollBack > 0) return `${scrollBack} back   Swipe down for newer   Tap to reply`;
    return "Tap to reply   Swipe up for older";
}

let shownHint: string | null = null;

/**
 * The strip is the same container in both layouts, so this works in either —
 * which is what lets "Sending Yes..." appear under the picker without rebuilding
 * the page out from under the gesture that started it.
 */
async function paintHint(): Promise<void> {
    if (!active) return;
    const content = hintText();
    if (content === shownHint) return;
    shownHint = content;
    try {
        await bridge.textContainerUpgrade(
            new TextContainerUpgrade({
                containerID: MSG_HINT_ID,
                containerName: "hint",
                content,
            }),
        );
    } catch (err) {
        appLog("Messages", "hint repaint failed", err);
    }
}

// ── building the page ───────────────────────────────────────────────────────

/** The full-screen layer that catches the temple gestures, behind everything. */
function eventLayer(): TextContainerProperty {
    return new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: BODY_W,
        // Full height, behind everything — the same layer every document page
        // builds. The hint strip sits on top of its bottom edge and wins on
        // z-order; only this container carries isEventCapture.
        height: BODY_H,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: 0,
        containerID: MSG_EVENT_ID,
        containerName: "msgEvent",
        content: " ",
        isEventCapture: 1,
        ...zOrder(Z_BACKDROP),
    });
}

function hintContainer(): TextContainerProperty {
    return new TextContainerProperty({
        xPosition: 0,
        yPosition: MSG_HINT_Y,
        width: BODY_W,
        height: MSG_HINT_H,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 4,
        containerID: MSG_HINT_ID,
        containerName: "hint",
        content: hintText(),
        isEventCapture: 0,
        ...zOrder(Z_HINT),
    });
}

function bubbleContainer(bubble: Bubble, index: number): TextContainerProperty {
    return new TextContainerProperty({
        xPosition: bubble.x,
        yPosition: bubble.y,
        width: bubble.w,
        height: bubble.h,
        // The box. A radius needs a border to be drawn as an outline — with
        // borderWidth 0 the display fills the shape instead and the text is
        // never seen (see menuContainer). Yours is the brighter frame, which is
        // the second cue after which edge it is on.
        borderWidth: BUBBLE_BORDER,
        borderColor: bubble.mine ? FOCUSED_COLOR : DEFAULT_COLOR,
        borderRadius: BUBBLE_RADIUS,
        paddingLength: BUBBLE_PAD,
        containerID: MSG_BUBBLE_IDS[index]!,
        containerName: `bubble${index}`,
        content: bubble.lines.join("\n"),
        isEventCapture: 0,
        ...zOrder(Z_BUBBLE_BASE + index),
    });
}

/**
 * The reply picker, which is a PAGE rather than an overlay.
 *
 * A panel floating over the conversation would need something opaque behind it,
 * and the only opaque thing this app has is an image (see menu.ts, which pushes
 * a generated backdrop into the four tiles a document page owns). This page has
 * no image containers — that is the point of it — so the picker replaces the
 * bubbles instead of covering them. It is modal anyway: while you are choosing
 * a reply, the conversation is not what you are looking at.
 */
function replyContainers(): TextContainerProperty[] {
    // Sized to its own contents, like a bubble, rather than borrowed from the
    // action menu's rectangle: that one is 6 rows tall because that is what the
    // menu needs, and a seventh reply in it would be a box with a scroller in
    // it — the exact failure this page exists to be rid of.
    const rows = Math.max(1, Math.floor((MSG_FLOOR - 2 * CONTAINER_PAD) / BUBBLE_LINE_H) - 1);
    // The list can be longer than the panel — the server supplies it — so the
    // window follows the marker instead of assuming everything is on screen.
    const first = Math.min(
        Math.max(0, replyIndex - Math.floor(rows / 2)),
        Math.max(0, quickReplies.length - rows),
    );
    const visible = quickReplies.slice(first, first + rows);

    const lines = ["REPLY"];
    visible.forEach((label, i) => {
        // ASCII only: the panel font has no glyph for the arrow you would reach
        // for first, and a missing glyph draws NOTHING rather than a box.
        lines.push(`${first + i === replyIndex ? "> " : "  "}${label}`);
    });

    const h = lines.length * BUBBLE_LINE_H + 2 * CONTAINER_PAD;

    return [
        eventLayer(),
        new TextContainerProperty({
            xPosition: MENU_X,
            yPosition: Math.max(0, Math.round((MSG_FLOOR - h) / 2)),
            width: MENU_W,
            height: h,
            borderWidth: 2,
            borderColor: FOCUSED_COLOR,
            borderRadius: BUBBLE_RADIUS,
            paddingLength: CONTAINER_PAD,
            containerID: MSG_REPLY_ID,
            containerName: "reply",
            content: lines.join("\n"),
            isEventCapture: 0,
            ...zOrder(Z_REPLY),
        }),
        hintContainer(),
    ];
}

/**
 * Put the page on the panel.
 *
 * Serialised through one chain: a rebuild that overlaps another one would have
 * two sets of containers racing to be the page, and messages arrive on a stream
 * that has no idea what the last gesture started.
 */
let chain: Promise<unknown> = Promise.resolve();
function rebuild(): Promise<void> {
    chain = chain.then(build).catch((err) => appLog("Messages", "rebuild failed", err));
    return chain as Promise<void>;
}

async function build(): Promise<void> {
    if (!active) return;

    const textObject =
        mode === "reply"
            ? replyContainers()
            : [
                  eventLayer(),
                  ...layout().map((bubble, i) => bubbleContainer(bubble, i)),
                  hintContainer(),
              ];

    // The hint's content is part of this page now, so what a later upgrade
    // dedupes against is whatever went out here.
    shownHint = hintText();

    // SDK limits: textObject <= 8. A rejected rebuild leaves the PREVIOUS
    // page's containers up, so an overrun would show as a Messages page that
    // has quietly stopped changing — hence MSG_MAX_BUBBLES.
    const ok = await bridge.rebuildPageContainer(
        new RebuildPageContainer({ containerTotalNum: textObject.length, textObject }),
    );
    if (!ok) appLog("Messages", "rebuild refused", textObject.length, "containers");
}

// ── the page ────────────────────────────────────────────────────────────────

/**
 * Built here rather than in main.ts, because there is no fixed set of
 * containers to declare: how many boxes there are, how big they are and where
 * they sit all come from the conversation.
 */
export async function buildMessagesPage(): Promise<void> {
    active = true;
    shownHint = null;
    if (mode !== "banner") {
        mode = "chat";
        scrollBack = 0;
    }
    note = "";
    await rebuild();

    // Opening the conversation is as good an acknowledgement as the banner is.
    const newest = messages.filter((m) => m.direction === "out" && !m.seen_at).pop();
    if (newest) void ackSeen(newest.id);
    void refresh();
}

export function leaveMessagesPage(): void {
    active = false;
    clearBannerTimer();
    mode = "chat";
    returnTo = null;
    note = "";
    scrollBack = 0;
    shownHint = null;
}

export function handleMessagesPageEvent(gesture: GESTURE_EVENTS): void {
    if (mode === "reply") {
        if (gesture === GESTURE_EVENTS.TAP) {
            void sendReply(quickReplies[replyIndex]!);
        } else if (gesture === GESTURE_EVENTS.SWIPE_DOWN) {
            replyIndex = (replyIndex + 1) % quickReplies.length;
            void rebuild();
        } else if (gesture === GESTURE_EVENTS.SWIPE_UP) {
            replyIndex = (replyIndex - 1 + quickReplies.length) % quickReplies.length;
            void rebuild();
        } else if (gesture === GESTURE_EVENTS.DOUBLE_TAP) {
            mode = returnTo !== null ? "banner" : "chat";
            note = "";
            void rebuild();
        }
        return;
    }

    switch (gesture) {
        case GESTURE_EVENTS.TAP:
            // A reply is worth more than the countdown: stop it, or the picker
            // vanishes underneath you halfway through choosing.
            clearBannerTimer();
            mode = "reply";
            replyIndex = 0;
            note = "";
            void rebuild();
            break;

        // One message per swipe, up into the past and back down towards the
        // newest. Each is a rebuild — the panel changes what it shows and then
        // holds still, which is what a scroller here could never do.
        case GESTURE_EVENTS.SWIPE_UP:
            clearBannerTimer();
            if (scrollBack < maxScrollBack()) {
                scrollBack++;
                void rebuild();
            }
            break;

        case GESTURE_EVENTS.SWIPE_DOWN:
            clearBannerTimer();
            if (scrollBack > 0) {
                scrollBack--;
                void rebuild();
            }
            break;

        case GESTURE_EVENTS.DOUBLE_TAP:
            if (mode === "banner") dismissBanner();
            else navigateBack();
            break;
    }
}
