// The Mine tile's chooser: your own answer, or the encyclopedia.
//
// WHY THIS ISN'T AN EIGHTH DASHBOARD TILE. The dashboard is seven tiles plus a
// backdrop, which is exactly the SDK's ceiling of 8 text containers
// (constants.ts MENU_ITEMS). An eighth is not "tight" — `rebuildPageContainer`
// REJECTS the page and leaves the previous one on screen, so the dashboard
// would simply stop responding, with nothing anywhere saying why.
//
// Mine is the right tile to share regardless. It already means "the things that
// are yours rather than the agent's", and a reference you assembled belongs
// next to working you wrote far more than it belongs next to the camera.
//
// One extra tap on the way to your answer is the cost. It is paid back by
// preselecting whichever half you used last, so the habitual path stays
// tap-tap.

import { TextContainerUpgrade } from "@evenrealities/even_hub_sdk";
import { ENC_BROWSE_ID, GESTURE_EVENTS, PAGES } from "../constants";
import { bridge, navigate, navigateBack } from "../main";
import { appLog } from "../debug";
import { resetEncBrowser } from "./browser";

const KEY = "evens.enc.hub";

interface Choice {
    label: string;
    detail: string;
    page: PAGES;
    onOpen?(): void;
}

const CHOICES: Choice[] = [
    {
        label: "Answer",
        detail: "Your own working on the scanned assignment.",
        page: PAGES.MINE,
    },
    {
        label: "Encyclopedia",
        detail: "Formulas, methods and worked problems. Works offline.",
        page: PAGES.ENC_BROWSE,
        // From the top. Resuming four levels down would be right if you had
        // just come back from a node — but you came from the dashboard, and
        // the tree you left is not where you meant to arrive.
        onOpen: resetEncBrowser,
    },
];

let focus = readFocus();
let active = false;

function readFocus(): number {
    try {
        return localStorage.getItem(KEY) === "enc" ? 1 : 0;
    } catch {
        return 0;
    }
}

function saveFocus(): void {
    try {
        localStorage.setItem(KEY, focus === 1 ? "enc" : "answer");
    } catch {
        // Storage off; the preselection is a nicety, not the feature.
    }
}

function body(): string {
    return [
        "MINE",
        "",
        ...CHOICES.map((c, i) => `${i === focus ? ">" : " "} ${c.label}`),
        "",
        CHOICES[focus].detail,
        "",
        "Swipe to choose - tap to open - 2x back",
    ].join("\n");
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
                containerName: "mineHub",
                content,
            }),
        );
    } catch (err) {
        appLog("MineHub", "repaint failed", err);
    }
}

export async function enterMineHubPage(): Promise<void> {
    active = true;
    shown = "";
    await repaint();
}

export function leaveMineHubPage(): void {
    active = false;
}

export function handleMineHubPageEvent(gesture: GESTURE_EVENTS): void {
    switch (gesture) {
        case GESTURE_EVENTS.SWIPE_UP:
        case GESTURE_EVENTS.SWIPE_DOWN:
            focus = (focus + (gesture === GESTURE_EVENTS.SWIPE_UP ? -1 : 1) + CHOICES.length) %
                CHOICES.length;
            void repaint();
            break;

        case GESTURE_EVENTS.TAP: {
            const choice = CHOICES[focus];
            saveFocus();
            choice.onOpen?.();
            navigate(choice.page);
            break;
        }

        case GESTURE_EVENTS.DOUBLE_TAP:
            navigateBack();
            break;
    }
}
