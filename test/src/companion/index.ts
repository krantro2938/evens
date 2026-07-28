// The companion app: the phone screen half of this project.
//
// The glasses are a reader and a pair of buttons. Everything that needs a
// keyboard, a file picker or more than two lines of text needs a screen, and
// until now this one said "Companion app is running. Check the glasses display."
//
// Five tabs. The first three are the camera workflow, in the order it happens:
//
//   Photo       give the reader a sheet to read — from the picker, or from the
//               phone's own camera roll via the gallery bridge
//   Assignment  what the reader made of it, with a copy button, and beneath it
//               the box you write your own answer in
//   Solution    read back what you saved
//
// The last two are Adri, which is the same idea with the machines taken out:
//
//   Adri task   an assignment you state yourself, not one a camera read
//   Adri answer the solution to it — ONE of them, replaced when you edit, and
//               shown on the glasses' Adri page
//
// IT SHARES THE GLASSES' BACKEND, NOT ITS CODE. Every tab talks to the same
// document server the glasses do, so a photo published here and a photo
// published from the Settings page are the same operation, and a solution typed
// here is on the glasses' AI page before you have put the phone down.
//
// The app is mounted only when there is a DOM to mount into — main.ts drives
// the glasses and must keep working in a host that never renders this at all.

import { mountPhotoTab } from "./photo";
import { mountAssignmentTab } from "./assignment";
import { mountSolutionTab } from "./solution";
import { mountDocTab } from "./doc";
import { el } from "./dom";

export interface Tab {
    id: string;
    label: string;
    /** Builds the tab's body. Called once, the first time the tab is opened. */
    mount: (root: HTMLElement) => void;
    /** Called every time the tab becomes visible — refresh what may be stale. */
    refresh?: () => void;
}

const TABS: Tab[] = [
    { id: "photo", label: "Photo", ...mountPhotoTab() },
    { id: "assignment", label: "Assignment", ...mountAssignmentTab() },
    { id: "solution", label: "Solution", ...mountSolutionTab() },
    {
        id: "adri-assignment",
        label: "Adri task",
        ...mountDocTab({
            slug: "adri-assignment",
            heading: "Adri — the assignment",
            blurb: "State it yourself. Nothing reads this off a camera; it is whatever you type here.",
            placeholder: "# Adri\n\n1. …\n\nMarkdown and $LaTeX$ both render on the glasses.",
        }),
    },
    {
        id: "adri-solution",
        label: "Adri answer",
        ...mountDocTab({
            slug: "adri-solution",
            heading: "Adri — the solution",
            blurb: "There is one of these. Saving replaces it, changes its version, and the glasses' Adri page redraws.",
            placeholder: "# Adri\n\n1. …",
        }),
    },
];

const ACTIVE_KEY = "evens.companion.tab";

export function mountCompanion(host: HTMLElement): void {
    host.textContent = "";
    host.className = "app";

    // role=tablist alongside the buttons' role=tab: a tab whose parent is not a
    // tablist is an incomplete pattern, and a screen reader then announces four
    // unrelated controls rather than one group with a selection.
    const tabBar = el("nav", { class: "tabs", role: "tablist" });
    const panels = el("div", { class: "panels" });

    const mounted = new Set<string>();
    const bodies = new Map<string, HTMLElement>();
    const buttons = new Map<string, HTMLButtonElement>();

    function show(id: string): void {
        for (const [key, body] of bodies) {
            const on = key === id;
            body.hidden = !on;
            buttons.get(key)?.classList.toggle("on", on);
            buttons.get(key)?.setAttribute("aria-selected", String(on));
        }
        const tab = TABS.find((t) => t.id === id);
        const body = bodies.get(id);
        if (!tab || !body) return;

        // Mounted lazily: the assignment and solution tabs each hit the server
        // on mount, and paying for all three on load makes the first paint wait
        // on requests for tabs you are not looking at.
        if (!mounted.has(id)) {
            mounted.add(id);
            tab.mount(body);
        }
        tab.refresh?.();
        try {
            localStorage.setItem(ACTIVE_KEY, id);
        } catch {
            /* a WebView with storage disabled just always opens on Photo */
        }
    }

    for (const tab of TABS) {
        const button = el("button", {
            class: "tab",
            type: "button",
            role: "tab",
            text: tab.label,
        }) as HTMLButtonElement;
        button.addEventListener("click", () => show(tab.id));
        buttons.set(tab.id, button);
        tabBar.append(button);

        const body = el("section", { class: "panel" });
        body.hidden = true;
        bodies.set(tab.id, body);
        panels.append(body);
    }

    host.append(tabBar, panels);

    let initial = TABS[0]!.id;
    try {
        const saved = localStorage.getItem(ACTIVE_KEY);
        if (saved && TABS.some((t) => t.id === saved)) initial = saved;
    } catch {
        /* fall through to the first tab */
    }
    show(initial);

    // Coming back to the app after taking a photo is the single most common
    // thing that happens between one interaction and the next — that is the
    // whole workflow — so the visible tab re-reads itself rather than showing
    // whatever was true when you left.
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        const current = [...bodies.entries()].find(([, body]) => !body.hidden)?.[0];
        if (current) TABS.find((t) => t.id === current)?.refresh?.();
    });
}
