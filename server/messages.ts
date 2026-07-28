// Short messages between the camera web app and the glasses.
//
// One direction is a person at a keyboard on cam.aansl.com; the other is a
// temple tap picking one of a handful of canned replies. That asymmetry is the
// whole design: there is no keyboard on the glasses, so "chat" here means a log
// you can write to from one end and acknowledge from the other.
//
// This module owns three things the routes in index.ts should not have to know:
// what a sendable message is (see `normalise`), who is listening, and whether
// the glasses are actually there.

import {
  insertMessage,
  markMessagesSeen,
  recentMessages,
  unseenCount,
  type MessageRow,
} from "./db";

/**
 * The cap the web widget enforces too.
 *
 * Derived from the panel, not picked: the glasses draw 576px-wide lines at
 * LINE_HEIGHT 27 into a PAGE_H of 252, so a page holds ~9 lines of ~45
 * characters. 240 fits on one page with room to spare, which means a message
 * never needs a pager and the banner never truncates mid-word.
 */
export const MESSAGE_MAX_CHARS = 240;

/** The canned replies the glasses offer. Short: they share a line with a marker. */
export const QUICK_REPLIES = ["Yes", "No", "OK", "Busy", "Call me"] as const;

// ── what the glasses can actually draw ──────────────────────────────────────
//
// The panel font has no glyph outside ASCII. A character it lacks does not draw
// a box — it logs `glyph dsc. not found` and SILENTLY DRAWS NOTHING, so an
// emoji becomes an invisible hole in a sentence and a curly quote eats a word's
// punctuation with no error anywhere.
//
// Which splits the problem in two. Typographic characters are what a phone
// keyboard and a copy-paste produce constantly, they all have exact ASCII
// equivalents, and nobody typing them means anything by them — so they are
// folded. Everything else non-ASCII (emoji, other scripts) has no honest
// substitute, and is refused by name rather than sent as a gap on someone's
// face.
const FOLD: Array<[RegExp, string]> = [
  [/[‘’‚‛]/g, "'"],
  [/[“”„‟]/g, '"'],
  [/[–—―]/g, "-"],
  [/[…]/g, "..."],
  [/[   ]/g, " "],
  [/[•]/g, "*"],
];

export interface Normalised {
  ok: boolean;
  /** The text to store, when ok. */
  body: string;
  /** Why not, when not ok — shown to the sender verbatim. */
  reason?: string;
  /** Characters that were folded to ASCII, for the widget to mention. */
  folded: boolean;
}

export function normalise(raw: unknown): Normalised {
  if (typeof raw !== "string") {
    return { ok: false, body: "", reason: "message must be a string", folded: false };
  }

  // Collapse newlines: the banner is one block of running text and a message
  // typed with hard wraps would page differently there than in the log.
  let body = raw.replace(/\r\n?/g, "\n").replace(/\n{2,}/g, "\n").trim();
  const before = body;
  for (const [re, to] of FOLD) body = body.replace(re, to);
  const folded = body !== before;

  if (!body) return { ok: false, body: "", reason: "message is empty", folded };
  if (body.length > MESSAGE_MAX_CHARS) {
    return {
      ok: false,
      body: "",
      reason: `message is ${body.length} characters; the limit is ${MESSAGE_MAX_CHARS}`,
      folded,
    };
  }

  // Tab and newline are fine; every other control character is not.
  const bad = [...body].filter((ch) => {
    const cp = ch.codePointAt(0)!;
    if (ch === "\n" || ch === "\t") return false;
    return cp < 0x20 || cp > 0x7e;
  });
  if (bad.length) {
    const shown = [...new Set(bad)].slice(0, 6).join(" ");
    return {
      ok: false,
      body: "",
      reason: `the glasses cannot draw ${shown} — ASCII only`,
      folded,
    };
  }

  return { ok: true, body, folded };
}

// ── fanout ──────────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();

export function subscribeMessages(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error("[messages] listener failed:", err);
    }
  }
}

// ── is anyone wearing them? ─────────────────────────────────────────────────
//
// DELIBERATELY TWO NUMBERS, because one would lie. An open SSE stream means the
// app is running on the phone; it does not mean the glasses are on a face or
// that the BLE link is up — the app can be foregrounded with the glasses in a
// drawer. `lastSeenAt` is the honest half: it only moves when the glasses
// acknowledge having DRAWN something. A green dot from the first number alone
// would say "online" about a phone in a pocket.
let streams = 0;
let lastSeenAt = 0;

export function messageStreamOpened(): void {
  streams++;
}
export function messageStreamClosed(): void {
  streams = Math.max(0, streams - 1);
}
function touch(): void {
  lastSeenAt = Date.now();
}

export interface MessageStatus {
  /** Open /messages/events streams — the app is running somewhere. */
  connected: number;
  /** Epoch ms the glasses last confirmed drawing a message, 0 if never. */
  lastSeenAt: number;
  unseen: number;
  maxChars: number;
  quickReplies: readonly string[];
}

export function getMessageStatus(): MessageStatus {
  return {
    connected: streams,
    lastSeenAt,
    unseen: unseenCount(),
    maxChars: MESSAGE_MAX_CHARS,
    quickReplies: QUICK_REPLIES,
  };
}

// ── the operations behind the routes ────────────────────────────────────────

export function send(body: string, direction: "out" | "in"): MessageRow {
  const row = insertMessage(body, direction);
  if (direction === "in") touch();
  notify();
  return row;
}

export function markSeen(id: number): number {
  const changed = markMessagesSeen(id);
  touch();
  // Even a no-op ack moves lastSeenAt, so the status is fresh — but only tell
  // the listeners when something actually changed, or a periodic ack from the
  // glasses would repaint every website widget on a timer.
  if (changed) notify();
  return changed;
}

export { recentMessages, unseenCount };
export type { MessageRow };
