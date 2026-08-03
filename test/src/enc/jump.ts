// The phone tells the glasses what to open.
//
// The companion app has a keyboard and a search box; the glasses have four
// gestures and a tree. So the useful division is: find it on the phone, read it
// on the glasses. This is the half-line of plumbing that joins them.
//
// A polled localStorage key rather than a call, for two reasons. The two halves
// of this app are mounted independently — the companion mounts BEFORE the
// bridge is connected (main.ts) — so a direct call would be a load-order
// dependency between them. And `storage` events only fire in OTHER documents,
// never in the one that wrote the key, which is exactly this case: same
// WebView, same process, so the event never arrives.

import { PAGES } from "../constants";
import { GlobalState } from "../state";
import { appLog } from "../debug";
import { dashboardAsleep } from "../dashboard";
import { jumpTo } from "./browser";
import { JUMP_KEY } from "../companion/encyclopedia";

/**
 * Slow on purpose. This is a person typing on a phone and then looking up; a
 * second of latency is invisible, and the poll runs for the life of the app.
 */
const POLL_MS = 1_500;

/**
 * How stale a request may be and still be acted on.
 *
 * Without this, a jump left in storage from yesterday fires the moment the app
 * starts, and the glasses open a page nobody asked for before the dashboard has
 * finished drawing.
 */
const MAX_AGE_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let lastSeen = 0;

interface Jump {
    id: string;
    at: number;
}

function read(): Jump | null {
    try {
        const raw = localStorage.getItem(JUMP_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Jump;
        return typeof parsed?.id === "string" && typeof parsed.at === "number" ? parsed : null;
    } catch {
        return null;
    }
}

async function check(): Promise<void> {
    const jump = read();
    if (!jump || jump.at <= lastSeen) return;
    lastSeen = jump.at;
    if (Date.now() - jump.at > MAX_AGE_MS) return;

    // Not while the dashboard is asleep. Waking the panel to show a page is a
    // surprise; the request keeps its timestamp and simply lapses, and tapping
    // the result again is one tap.
    if (GlobalState.currentPage === PAGES.DASHBOARD && dashboardAsleep()) return;

    appLog("Enc", "jump from the companion app", jump.id);
    if (!(await jumpTo(jump.id))) appLog("Enc", "jump target not in the tree", jump.id);
}

export function startEncJumpWatch(): void {
    if (timer) return;
    // Anything already in storage at start-up belongs to a previous session.
    lastSeen = read()?.at ?? 0;
    timer = setInterval(() => void check(), POLL_MS);
}

export function stopEncJumpWatch(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
}
