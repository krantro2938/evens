// The companion app: the phone screen half of this project.
//
// The glasses are a reader and a pair of buttons. Everything that needs a
// keyboard, a file picker or more than two lines of text needs a screen, and
// until now this one said "Companion app is running. Check the glasses display."
//
// Three tabs, in the order the work actually happens:
//
//   Photo       give the reader a sheet to read — from the picker, or from the
//               phone's own camera roll via the gallery bridge
//   Assignment  what the reader made of it, with a copy button
//   Solution    your own answer: one document, written and read back here
//   Справочник  search the offline study pack and open a node on the glasses —
//               the tree browser there has four gestures and no keyboard, so
//               "which topic covers this" is a question only this screen can
//               answer
//
// The Adri documents are edited in the CAMERA web app (cam.aansl.com), not
// here — see lookcam/web. They are typed on a keyboard rather than a phone, and
// that app is the one already sitting open on a desktop.
//
// IT SHARES THE GLASSES' BACKEND, NOT ITS CODE. Every tab talks to the same
// document server the glasses do, so a photo published here and a photo
// published from the Settings page are the same operation, and a solution typed
// here is on the glasses' Mine page before you have put the phone down.
//
// AND IT KEEPS A COPY OF EVERYTHING IT SHOWS. The reader lives on a VPS and the
// phone is the device most likely to lose it, so each tab mirrors its document
// to localStorage and shows that, labelled, when a fetch fails — and a solution
// saved with no signal is held and synced later rather than refused. See
// cache.ts.
//
// The app is mounted only when there is a DOM to mount into — main.ts drives
// the glasses and must keep working in a host that never renders this at all.

import { mountPhotoTab } from "./photo";
import { mountAssignmentTab } from "./assignment";
import { mountSolutionTab } from "./solution";
import { mountEncyclopediaTab } from "./encyclopedia";
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
    // Last, because it is the only tab that is not part of getting an answer
    // out of a sheet of paper — it is the reference you consult while doing it.
    { id: "enc", label: "Справочник", ...mountEncyclopediaTab() },
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
        // on mount (after painting their cached copy), and paying for all three
        // on load makes the first paint wait on requests for tabs you are not
        // looking at.
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
