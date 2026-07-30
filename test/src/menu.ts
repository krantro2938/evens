// A centred action menu for any page that has run out of gestures.
//
// The G2 gives you four inputs — tap, double tap, and two swipes — and a
// document page spends all of them on paging and navigation. This turns one
// gesture into as many actions as you like: it lists them in a panel, slides a
// marker with the swipes, and confirms with a tap.
//
//   const menu = createMenu({ containerID, enqueue, build, onPaint });
//
//   handleGesture(g) {
//       if (menu.handleGesture(g)) return;      // menu ate it
//       if (g === GESTURE_EVENTS.DOUBLE_TAP) return menu.open();
//       ...
//   }
//
// The owner supplies `build()` so the entries can depend on live state, and
// `enqueue` so the menu's writes join the page's own chain instead of racing
// its tile pushes.
//
// Two placement notes, both learned the hard way:
//
//   - The panel overlaps whatever the page draws underneath, so it is only
//     visible if this SDK build draws text ABOVE images. `menu.line()` gives
//     the owner the same selection as one line for a strip that can't be
//     covered (a footer), which is what makes the menu survive either way.
//   - Everything here is ASCII. The panel font has no glyph for the arrows and
//     bullets you'd reach for first — "▸" logs `glyph dsc. not found for
//     U+25B8` and the label silently fails to draw.

import {
    TextContainerProperty,
    TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import {
    CONTAINER_PAD,
    FOCUSED_COLOR,
    GESTURE_EVENTS,
    MENU_H,
    MENU_IN_FOOTER,
    MENU_LINES,
    MENU_MAX_ENTRIES,
    MENU_W,
    MENU_X,
    MENU_Y,
    Z_MENU,
    zOrder,
} from "./constants";
import { bridge } from "./main";
import { base64ToBytes } from "./render/tiles";
import { MENU_BACKDROP_TILES } from "./render/menuBackdrop";
import { appLog } from "./debug";

export interface MenuEntry {
    /** Kept short: it shares a line with the marker, and is mirrored into a
     *  one-line footer where space is tight. */
    label: string;
    run(): void | Promise<void>;
}

export interface MenuConfig {
    /** Shown in log lines. */
    name: string;
    /** The panel container, declared with the page via `menuContainer()`. */
    containerID: number;
    /** Build the entries from whatever the page knows right now. Called on
     *  every open, so the menu always matches current state. More than
     *  MENU_MAX_ENTRIES is fine — the panel scrolls a window over them. */
    build(): MenuEntry[];
    /** The page's write chain, so menu paints can't interleave with tile
     *  pushes (`updateImageRawData` must be strictly serial). */
    enqueue<T>(task: () => Promise<T>): Promise<T | void>;
    /** Repaint whatever mirrors `line()` — typically the page's footer. */
    onPaint?(): Promise<void> | void;
    /**
     * How to put the menu's backdrop up and take it down. Text containers are
     * transparent, so without this the panel reads as text over whatever the
     * page is already showing. The menu supplies the images (they carry its
     * frame); the page supplies only the means to display them, because it
     * owns the image containers and knows how to restore them.
     */
    backdrop?: {
        show(tiles: readonly Uint8Array[]): Promise<void>;
        hide(): Promise<void>;
    };
    /**
     * First line of the panel. Pass a function to have it reflect live state:
     * which entries exist usually depends on that state, and a menu that shows
     * the consequence without the cause reads as a bug ("why is there no
     * Stop?"). Evaluated on every repaint.
     */
    heading?: string | (() => string);
    /** Auto-dismiss, so a menu opened by accident puts itself away. */
    timeoutMs?: number;
}

export interface Menu {
    open(): void;
    /** `repaint: false` when the page is going away and its containers with it. */
    close(repaint?: boolean): void;
    isOpen(): boolean;
    /** The selection as one line, or null when closed. For the owner's footer. */
    line(): string | null;
    /** Returns true when the menu consumed the gesture. */
    handleGesture(gesture: GESTURE_EVENTS): boolean;
}

/**
 * The panel container. Declare it with the rest of the page and leave it
 * blank — it can't be created on demand, because border width is fixed at
 * build time, so a container that came and went would force a full page
 * rebuild (and a re-push of every image tile) on each open. A text container
 * holding " " draws nothing, so an always-present one costs only its slot.
 */
export function menuContainer(
    containerID: number,
    zOrderIndex: number = Z_MENU,
): TextContainerProperty {
    return new TextContainerProperty({
        xPosition: MENU_X,
        yPosition: MENU_Y,
        width: MENU_W,
        height: MENU_H,
        // No border, and therefore NO borderRadius. Every container in this app
        // that renders text has either no radius or a radius with a real
        // border; a radius with borderWidth 0 is the one combination nothing
        // else uses, and it drew as a filled block with no text in it. A
        // rounded rect with no stroke is a shape a renderer fills rather than
        // outlines, so don't ask for one.
        borderWidth: 0,
        borderColor: FOCUSED_COLOR,
        paddingLength: CONTAINER_PAD,
        containerID,
        containerName: "menu",
        // Above the image tiles it overlaps. Without this the host stacks by
        // declaration order and images win, so the panel drew every time and
        // was never once visible.
        ...zOrder(zOrderIndex),
        // Blank, but MENU_LINES tall: a host that lays a text box out from its
        // initial content would otherwise size this to one line and clip the
        // menu when it arrives. Spaces draw nothing, so it stays invisible.
        content: BLANK,
        isEventCapture: 0,
    });
}

const DEFAULT_HEADING = "ACTIONS   swipe / tap=ok";
const DEFAULT_TIMEOUT_MS = 12_000;

/** Full-height whitespace — see menuContainer(). */
const BLANK = Array(MENU_LINES).fill(" ").join("\n");

/**
 * Decoded once, then reused: the backdrop is the same every time it goes up.
 *
 * Exported because the menu is not the only modal thing on a page — the AI
 * page's solve button occupies this same rectangle and wants the same frame
 * behind it (see SOLVE_RECT). Sharing the images is what keeps there being one
 * generated asset instead of one per overlay.
 */
let backdropTiles: Uint8Array[] | null = null;
export function backdrop(): Uint8Array[] {
    if (!backdropTiles) backdropTiles = MENU_BACKDROP_TILES.map(base64ToBytes);
    return backdropTiles;
}

// ── who is open, app-wide ───────────────────────────────────────────────────
//
// Every page builds its own menu, so nothing could previously answer "is the
// wearer mid-choice right now" — and the one thing that most needs to ask is
// the arriving-message card, which takes the whole screen. Landing that on top
// of an open menu doesn't just hide it: the gesture you were about to make goes
// to the card instead, so a swipe meant to move the marker dismisses a message
// you never read, and the menu you left behind times out unseen.
//
// Identity, not a counter: a page torn down mid-open calls close(false), and a
// count would drift by one every time that raced an open.

const openMenus = new Set<object>();
const closedListeners = new Set<() => void>();

/** Whether any page currently has its action menu up. */
export function anyMenuOpen(): boolean {
    return openMenus.size > 0;
}

/** Called when the last open menu closes — never when one of several closes. */
export function subscribeMenusClosed(fn: () => void): () => void {
    closedListeners.add(fn);
    return () => closedListeners.delete(fn);
}

function markClosed(token: object): void {
    if (!openMenus.delete(token)) return;
    if (openMenus.size === 0) for (const fn of closedListeners) fn();
}

export function createMenu(config: MenuConfig): Menu {
    /** This menu's identity in `openMenus`. Nothing reads it but the set. */
    const token = {};
    const heading = () => {
        const h = config.heading ?? DEFAULT_HEADING;
        return typeof h === "function" ? h() : h;
    };
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let entries: MenuEntry[] | null = null;
    let selected = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Cleared if the host rejects a write to the panel container — the page
    // forgot menuContainer(), or its rebuild was refused. There's no point
    // retrying on every swipe, and the footer mirror carries the menu alone.
    //
    // Reset on every open() rather than kept for the session. One refused write
    // is usually transient (a rebuild landing in the same moment), and treating
    // it as permanent is what turned a single bad frame into a menu that drew a
    // dark backdrop with nothing in it for the rest of the session — the panel
    // was disabled, but the thing that makes the panel readable still went up.
    let panel = !MENU_IN_FOOTER;
    // Whether the backdrop is currently up, so a menu that loses its panel can
    // take it back down instead of leaving a black box on screen.
    let backdropUp = false;

    /**
     * Every action at once, marker on the current one — so you can see where
     * you are and what else is there without cycling through it.
     *
     * A list longer than the panel scrolls instead of being clipped: the
     * container's height is fixed when the page is built, and a version picker
     * has as many entries as there have been solves. The window keeps the
     * selection in the middle where possible, and pins to an end otherwise, so
     * the first and last entries are reachable without the marker vanishing.
     * `line()` carries the "n/total" that says there is more.
     */
    function body(): string {
        const menu = entries!;
        const start =
            menu.length <= MENU_MAX_ENTRIES
                ? 0
                : Math.min(
                      Math.max(0, selected - Math.floor((MENU_MAX_ENTRIES - 1) / 2)),
                      menu.length - MENU_MAX_ENTRIES,
                  );
        const lines = menu
            .slice(start, start + MENU_MAX_ENTRIES)
            .map((e, i) => `${start + i === selected ? ">" : " "} ${e.label}`);
        return [heading(), ...lines].join("\n");
    }

    function paint(): void {
        void config.enqueue(async () => {
            if (panel) {
                const ok = await bridge.textContainerUpgrade(
                    new TextContainerUpgrade({
                        containerID: config.containerID,
                        containerName: "menu",
                        // Whitespace rather than "": a blank container draws
                        // nothing, which is how the panel leaves without a
                        // page rebuild.
                        content: entries ? body() : BLANK,
                    }),
                );
                if (!ok) {
                    // The container isn't there. Note that this is NOT the same
                    // as the panel being invisible: a write that succeeds and
                    // shows nothing means it drew behind the image tiles, which
                    // no amount of retrying fixes either.
                    panel = false;
                    appLog(config.name, "menu panel write refused - footer only");
                    // The backdrop exists to make the panel readable. With no
                    // panel it is just a dark rectangle over the page, and the
                    // footer mirror — which no tile can cover — is carrying the
                    // menu on its own. Take it down: an unreadable black box is
                    // worse than the document it was hiding.
                    if (backdropUp) {
                        backdropUp = false;
                        await config.backdrop?.hide();
                    }
                }
            }
            await config.onPaint?.();
        });
    }

    function arm(): void {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => close(), timeoutMs);
    }

    function close(repaint = true): void {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (!entries) return;
        entries = null;
        // Before the repaint, so anything that reacts to the last menu closing
        // (an arriving message waiting its turn) sees an app with none open.
        markClosed(token);
        if (!repaint) {
            // The page is being torn down with its containers; nothing to put
            // back, but the next open must not think a backdrop is still up.
            backdropUp = false;
            return;
        }
        // Blank the text BEFORE the document comes back, or there is a moment
        // with the menu still legible over a restored page.
        paint();
        if (backdropUp) {
            backdropUp = false;
            void config.enqueue(() => config.backdrop?.hide() ?? Promise.resolve());
        }
    }

    function move(delta: number): void {
        const menu = entries;
        if (!menu) return;
        selected = (selected + delta + menu.length) % menu.length;
        arm();
        paint();
    }

    function confirm(): void {
        const entry = entries?.[selected];
        if (!entry) return;
        // Close first: the page is about to show the action's own progress, and
        // a stale menu behind it would be repainted by the next state change.
        close();
        void entry.run();
    }

    return {
        isOpen: () => entries !== null,

        line: () =>
            entries
                ? `> ${entries[selected].label}   ${selected + 1}/${entries.length}   tap=ok`
                : null,

        open(): void {
            entries = config.build();
            openMenus.add(token);
            selected = 0;
            // A fresh attempt at the panel every time. See the note at `panel`:
            // the previous open failing is not evidence that this one will.
            panel = !MENU_IN_FOOTER;
            arm();
            // Backdrop first: it masks the document, so the panel's text lands
            // on something dark rather than flashing over the page.
            backdropUp = true;
            void config.enqueue(
                () => config.backdrop?.show(backdrop()) ?? Promise.resolve(),
            );
            paint();
        },

        close,

        handleGesture(gesture: GESTURE_EVENTS): boolean {
            if (!entries) return false;
            switch (gesture) {
                case GESTURE_EVENTS.SWIPE_UP:
                    move(-1);
                    return true;
                case GESTURE_EVENTS.SWIPE_DOWN:
                    move(1);
                    return true;
                case GESTURE_EVENTS.TAP:
                    confirm();
                    return true;
                case GESTURE_EVENTS.DOUBLE_TAP:
                    close();
                    return true;
            }
            return false;
        },
    };
}
