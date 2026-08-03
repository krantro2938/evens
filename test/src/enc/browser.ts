// Walking the encyclopedia's tree.
//
// ONE TEXT CONTAINER AND NOTHING ELSE. No tiles, no images, no server round
// trip once the tree is on the device — a swipe repaints a string. That is the
// requirement: this is the thing you use with a half-finished problem in front
// of you, and a navigation step that costs a BLE image push is a navigation
// step you stop using.
//
// The whole page is a line budget, exactly like Settings: the container is
// BODY_H tall with CONTAINER_PAD above and below, so nine LINE_HEIGHT rows fit
// and a tenth does not — and content taller than its container gets a SCROLLER
// attached by the host, which then eats the swipes that move the cursor. So:
// one heading, seven rows, one footer, every one of them clamped to a single
// line. Nothing here is allowed to wrap.

import { TextContainerUpgrade } from "@evenrealities/even_hub_sdk";
import { ENC_BROWSE_ID, GESTURE_EVENTS, PAGES } from "../constants";
import { bridge, navigate, navigateBack } from "../main";
import { appLog } from "../debug";
import { loadToc, type Toc, type TocNode } from "./pack";
import { label as labelOf } from "./labels";
import { openNode } from "./reader";
import { recent, rememberVisit } from "./recent";
import { matchAssignment } from "./find";

/** Rows of entries between the heading and the footer. */
const WINDOW = 7;

/**
 * Characters a row may hold before it wraps and costs a second line.
 *
 * The packer already clamps labels to 44 (tools/enc/split.ts), measured against
 * the real panel font. This is the same bound applied to everything else that
 * reaches a row — a breadcrumb, a search result, an error — because one wrapped
 * line is the tenth line, and the tenth line is a scroller.
 */
const ROW_MAX = 44;

const clamp = (text: string, max = ROW_MAX): string =>
    text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * Two entries the pack does not contain, because neither is a fixed part of the
 * tree: one is computed from whatever the camera last read, the other from
 * where you have been.
 */
const FIND_ID = "@find";
const RECENT_ID = "@recent";

interface Entry {
    id: string;
    label: string;
}

interface Level {
    /** What the heading says. */
    title: string;
    entries: Entry[];
    selected: number;
}

let toc: Toc | null = null;
let stack: Level[] = [];
let active = false;
let status = "";

// ── building levels ────────────────────────────────────────────────────────

function entriesOf(ids: readonly string[]): Entry[] {
    const nodes = toc?.nodes ?? {};
    return ids
        .filter((id) => nodes[id])
        .map((id) => ({ id, label: clamp(labelOf(nodes[id])) }));
}

function rootLevel(): Level {
    const children = toc?.nodes.root?.children ?? [];
    return {
        title: "Справочник",
        entries: [
            ...entriesOf(children),
            // After the syllabus, not before it: these two are shortcuts, and a
            // shortcut above the thing it is a shortcut to is just a second
            // front door.
            { id: FIND_ID, label: "По заданию" },
            { id: RECENT_ID, label: "Недавнее" },
        ],
        selected: 0,
    };
}

function levelFor(node: TocNode): Level {
    return {
        title: clamp(labelOf(node)),
        entries: entriesOf(node.children ?? []),
        selected: 0,
    };
}

async function findLevel(): Promise<Level> {
    const ids = await matchAssignment(toc);
    return {
        title: "По заданию",
        entries: ids.length
            ? entriesOf(ids)
            // Not an empty list: an empty list is indistinguishable from a
            // broken one, and this has three quite different causes.
            : [{ id: "", label: "Ничего не найдено" }],
        selected: 0,
    };
}

function recentLevel(): Level {
    const ids = recent();
    return {
        title: "Недавнее",
        entries: ids.length ? entriesOf(ids) : [{ id: "", label: "Пусто" }],
        selected: 0,
    };
}

// ── painting ───────────────────────────────────────────────────────────────

const here = (): Level | undefined => stack[stack.length - 1];

/**
 * The visible slice, with the cursor kept in the middle where it can be.
 *
 * Borrowed from menu.ts's `body()` for the same reason it exists there: a list
 * longer than the panel has to scroll rather than clip, and pinning the window
 * at the ends is what makes the first and last entries reachable without the
 * marker disappearing off the edge.
 */
function rows(level: Level): string[] {
    const { entries, selected } = level;
    const start =
        entries.length <= WINDOW
            ? 0
            : Math.min(
                  Math.max(0, selected - Math.floor((WINDOW - 1) / 2)),
                  entries.length - WINDOW,
              );
    return entries
        .slice(start, start + WINDOW)
        .map((e, i) => `${start + i === selected ? ">" : " "} ${e.label}`);
}

function body(): string {
    const level = here();
    if (!level) return ["СПРАВОЧНИК", "", status || "Загрузка…"].join("\n");

    if (!level.entries.length) {
        return [clamp(level.title.toUpperCase()), "", "Пусто", "", "2x назад"].join("\n");
    }

    const footer =
        stack.length > 1
            ? `${level.selected + 1}/${level.entries.length}  тап - открыть, 2x - назад`
            : `${level.selected + 1}/${level.entries.length}  тап - открыть`;

    return [clamp(level.title.toUpperCase()), ...rows(level), clamp(footer, 52)].join("\n");
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
                containerID: ENC_BROWSE_ID,
                containerName: "encBrowse",
                content,
            }),
        );
    } catch (err) {
        appLog("Enc", "browser repaint failed", err);
    }
}

// ── the page ───────────────────────────────────────────────────────────────

export async function enterEncBrowsePage(): Promise<void> {
    active = true;
    // Reset the dedup, not the stack: the container was rebuilt blank by
    // buildPage, so a repaint that dedups against the last visit's text would
    // leave the panel empty. The STACK deliberately survives — coming back from
    // a node should land on the row you opened it from, not at the root.
    shown = "";

    if (!toc) {
        status = "Загрузка…";
        void repaint();
        toc = await loadToc();
        if (!toc) {
            status = "Справочник недоступен. Сервер не отвечает.";
            return void repaint();
        }
    }
    if (!stack.length) stack = [rootLevel()];
    void repaint();
}

export function leaveEncBrowsePage(): void {
    active = false;
}

/** Start again from the top — the Mine hub's entry point. */
export function resetEncBrowser(): void {
    stack = [];
}

async function open(entry: Entry): Promise<void> {
    // The placeholder row of an empty result. Selectable so the list is not a
    // special case, inert so tapping it does nothing surprising.
    if (!entry.id) return;

    if (entry.id === FIND_ID) {
        status = "Ищу…";
        void repaint();
        stack.push(await findLevel());
        return void repaint();
    }
    if (entry.id === RECENT_ID) {
        stack.push(recentLevel());
        return void repaint();
    }

    const node = toc?.nodes[entry.id];
    if (!node) return;

    if (node.children?.length) {
        stack.push(levelFor(node));
        return void repaint();
    }
    if (node.pages) {
        rememberVisit(entry.id);
        await openNode(entry.id);
        navigate(PAGES.ENC_READ);
    }
}

export function handleEncBrowsePageEvent(gesture: GESTURE_EVENTS): void {
    const level = here();
    if (!level) {
        // Nothing loaded — the only useful gesture is the one that leaves.
        if (gesture === GESTURE_EVENTS.DOUBLE_TAP) navigateBack();
        return;
    }

    switch (gesture) {
        case GESTURE_EVENTS.SWIPE_UP:
        case GESTURE_EVENTS.SWIPE_DOWN: {
            const count = level.entries.length;
            if (count < 2) return;
            const step = gesture === GESTURE_EVENTS.SWIPE_UP ? -1 : 1;
            // Wraps, like the dashboard's focus: the alternative is a list you
            // can be stuck at the bottom of with six swipes back to the top.
            level.selected = (level.selected + step + count) % count;
            void repaint();
            break;
        }

        case GESTURE_EVENTS.TAP:
            void open(level.entries[level.selected]);
            break;

        case GESTURE_EVENTS.DOUBLE_TAP:
            // Up one level, and only OUT of the encyclopedia from the root.
            // Going straight to the dashboard from four levels down would make
            // the back gesture mean two different things depending on where you
            // were, which is the kind of thing you find out by accident.
            if (stack.length > 1) {
                stack.pop();
                void repaint();
            } else {
                navigateBack();
            }
            break;
    }
}

/** Jump straight to a node — the companion app's search result. */
export async function jumpTo(id: string): Promise<boolean> {
    if (!toc) toc = await loadToc();
    const node = toc?.nodes[id];
    if (!node?.pages) return false;
    rememberVisit(id);
    await openNode(id);
    navigate(PAGES.ENC_READ);
    return true;
}
