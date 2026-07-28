// Tab 4 — read back what you saved.
//
// Separate from the tab you write in, and separate from whatever the AI page is
// currently showing. Both distinctions are deliberate: the writing tab is a
// draft you are still editing, and the AI page shows the NEWEST solution, which
// becomes the agent's the moment a solve run lands. This tab always shows the
// last thing YOU saved, which is the only place that stays true.

import { MARKDOWN_SERVER_URL } from "../constants";
import { ago } from "../utils";
import { copyText, el, status } from "./dom";

interface MySolution {
    saved: boolean;
    id?: number;
    markdown: string;
    notes?: string | null;
    created_at?: number;
}

export function mountSolutionTab(): {
    mount: (root: HTMLElement) => void;
    refresh: () => void;
} {
    const state = status();
    let text = "";
    let body: HTMLElement;
    let meta: HTMLElement;
    let copyButton: HTMLButtonElement;

    async function load(): Promise<void> {
        try {
            const res = await fetch(`${MARKDOWN_SERVER_URL}/solution/mine`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const mine = (await res.json()) as MySolution;

            text = mine.markdown ?? "";
            if (!mine.saved) {
                body.textContent = "You haven't saved a solution yet. Write one in the Solve tab.";
                meta.textContent = "";
                copyButton.disabled = true;
                return;
            }
            body.textContent = text;
            meta.textContent = `Saved ${mine.created_at ? ago(mine.created_at) : "recently"} · ${
                text.length
            } characters`;
            copyButton.disabled = false;
            state.clear();
        } catch (err) {
            state.error(err instanceof Error ? err.message : String(err));
        }
    }

    function mount(root: HTMLElement): void {
        meta = el("p", { class: "muted" });
        body = el("pre", { class: "doc", text: "Loading..." });

        copyButton = el("button", {
            class: "btn primary",
            type: "button",
            text: "Copy",
        }) as HTMLButtonElement;
        copyButton.disabled = true;
        copyButton.addEventListener("click", () => {
            void copyText(text).then((done) =>
                done ? state.ok("Copied.") : state.error("Could not copy."),
            );
        });

        const reload = el("button", { class: "btn", type: "button", text: "Refresh" }) as HTMLButtonElement;
        reload.addEventListener("click", () => void load());

        root.append(
            el("h2", { text: "My solution" }),
            meta,
            el("div", { class: "row" }, copyButton, reload),
            state.node,
            body,
        );
    }

    return { mount, refresh: () => void load() };
}
