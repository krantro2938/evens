// A persistent panel: a text container that sits over the document and stays
// there — camera advice today, notifications next.
//
// The awkward part is the background. A text container is TRANSPARENT, and a
// page gets four image containers which the document already uses, so there is
// no layer to slide underneath. Two ways out, and this is the one for anything
// that has to coexist with the document:
//
//   the server bakes it in.  Its region is declared as `reserved` when the
//   tiles are rendered (server/render/constants.ts), so every tile arrives with
//   that rectangle already dark and framed. Costs nothing at runtime, survives
//   paging, and the container on top is pure text.
//
// The other way is the action menu's: replace all four tiles with a backdrop
// and take the screen over (see menu.ts). That suits something transient and
// modal; it is wrong for a panel that must not hide the document.
//
// So: no borders here. Every panel's frame is in the tile, because borderWidth
// is fixed when the page is built and a container can't draw one on demand.

import { TextContainerProperty, TextContainerUpgrade } from "@evenrealities/even_hub_sdk";
import { zOrder } from "./constants";
import { bridge } from "./main";

/** A region of the panel, in the same coordinates the server reserves. */
export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface PanelConfig {
    containerID: number;
    /** Container name; also used in log lines. */
    name: string;
    /** Where it sits. MUST match the server's reserved rect for this document. */
    rect: Rect;
    /** Stacking slot — above the tiles, below the action menu. */
    zOrderIndex: number;
    /** Clearance from the baked frame. */
    padding?: number;
    /** The page's write chain, so panel writes don't interleave with tiles. */
    enqueue<T>(task: () => Promise<T>): Promise<T | void>;
}

export interface Panel {
    /** Replace the panel's text. Whitespace draws nothing. */
    set(text: string): void;
    /** Clear it without disturbing the baked background. */
    clear(): void;
    /**
     * Forget what is on screen, without writing anything.
     *
     * Call this whenever the page has been rebuilt. A panel outlives the
     * containers it writes to — it is created once at module scope, while
     * `rebuildPageContainer` makes a brand-new container holding " " every time
     * you enter the page. The dedup below would then compare against the *last
     * visit's* text and skip the write, leaving the panel blank: leave the AI
     * page while it says CLAUDE IS SOLVING, come back, and the box is empty
     * behind its backdrop with nothing but a status event that says nothing
     * changed.
     */
    reset(): void;
}

const DEFAULT_PADDING = 6;

/**
 * The container. Declare it with the page — like the menu's, it can't be
 * created on demand, and unlike the menu's it is meant to be visible for the
 * whole life of the page anyway.
 */
export function panelContainer(config: {
    containerID: number;
    name: string;
    rect: Rect;
    zOrderIndex: number;
    padding?: number;
}): TextContainerProperty {
    return new TextContainerProperty({
        xPosition: config.rect.x,
        yPosition: config.rect.y,
        width: config.rect.w,
        height: config.rect.h,
        // No border and no radius: the frame is baked into the tiles. A border
        // here would double it up, and a radius with no border is the one
        // combination this display does not draw text inside of.
        borderWidth: 0,
        borderColor: 0,
        paddingLength: config.padding ?? DEFAULT_PADDING,
        containerID: config.containerID,
        containerName: config.name,
        content: " ",
        isEventCapture: 0,
        ...zOrder(config.zOrderIndex),
    });
}

export function createPanel(config: PanelConfig): Panel {
    let shown: string | null = null;

    const write = (content: string) => {
        // The panel is repainted on every status event, and most of them say
        // the same thing. A container upgrade is cheap but not free.
        if (content === shown) return;
        shown = content;
        void config.enqueue(() =>
            bridge.textContainerUpgrade(
                new TextContainerUpgrade({
                    containerID: config.containerID,
                    containerName: config.name,
                    content,
                }),
            ),
        );
    };

    return {
        set: (text) => write(text || " "),
        clear: () => write(" "),
        reset: () => {
            shown = null;
        },
    };
}
