// Tab 2 — what the reader made of the sheet, and your answer to it.
//
// The same markdown the glasses render into tiles, as text you can select,
// scroll and copy. That last one is the point: the transcription is the input
// to whatever you actually solve the paper with, and until now the only way to
// get it off the glasses was to ask the server for it yourself.
//
// The editor sits directly beneath it, on the same tab, because writing an
// answer means reading the question — and because saving is what puts your own
// working on the glasses. It lands in the same table as a solve run's answer,
// and the AI page shows the newest solution whoever wrote it.

import { MARKDOWN_SERVER_URL, POLL_INTERVAL_MS } from "../constants";
import { copyText, el, status } from "./dom";

/** An unsaved answer, kept locally so a backgrounded tab can't eat it. */
const DRAFT_KEY = "evens.companion.draft";

interface MarkdownResponse {
    content: string;
    version: number;
}

interface AssignmentStatus {
    upstream: string;
    running: boolean;
    done: boolean;
    captures: number;
    problems: number;
    problems_complete: number;
    version: number;
}

export function mountAssignmentTab(): {
    mount: (root: HTMLElement) => void;
    refresh: () => void;
} {
    const state = status();
    let text = "";
    let body: HTMLElement;
    let meta: HTMLElement;
    let copyButton: HTMLButtonElement;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function load(): Promise<void> {
        try {
            const [docRes, statusRes] = await Promise.all([
                fetch(`${MARKDOWN_SERVER_URL}/assignment/markdown`),
                fetch(`${MARKDOWN_SERVER_URL}/assignment/status`),
            ]);
            if (!docRes.ok) throw new Error(`markdown HTTP ${docRes.status}`);

            const doc = (await docRes.json()) as MarkdownResponse;
            text = doc.content ?? "";
            body.textContent = text || "Nothing transcribed yet.";
            copyButton.disabled = !text;

            if (statusRes.ok) {
                const s = (await statusRes.json()) as AssignmentStatus;
                meta.textContent = describe(s);
            }
            state.clear();
        } catch (err) {
            state.error(err instanceof Error ? err.message : String(err));
        }
    }

    function describe(s: AssignmentStatus): string {
        if (s.upstream === "disabled") return "No reader configured.";
        if (s.upstream !== "open") return `Reader ${s.upstream}.`;
        const parts = [
            `${s.problems} problem${s.problems === 1 ? "" : "s"}`,
            `${s.problems_complete} complete`,
            `${s.captures} capture${s.captures === 1 ? "" : "s"}`,
        ];
        if (s.running) parts.push("scanning now");
        else if (s.done) parts.push("finished");
        return parts.join(" · ");
    }

    function mount(root: HTMLElement): void {
        meta = el("p", { class: "muted" });
        body = el("pre", { class: "doc", text: "Loading..." });

        copyButton = el("button", {
            class: "btn primary",
            type: "button",
            text: "Copy markdown",
        }) as HTMLButtonElement;
        copyButton.disabled = true;
        copyButton.addEventListener("click", () => {
            void copyText(text).then((done) =>
                done
                    ? state.ok(`Copied ${text.length} characters.`)
                    : state.error("Could not copy — select the text and copy it by hand."),
            );
        });

        const reload = el("button", { class: "btn", type: "button", text: "Refresh" }) as HTMLButtonElement;
        reload.addEventListener("click", () => void load());

        root.append(
            el("h2", { text: "Assignment" }),
            meta,
            el("div", { class: "row" }, copyButton, reload),
            state.node,
            body,
            // Directly beneath the problems, not on a tab of its own: writing an
            // answer means reading the question, and a solution editor you have
            // to leave the paper to reach is one you check against memory.
            solutionEditor(),
        );
    }

    // ── your own answer ─────────────────────────────────────────────────────

    function solutionEditor(): HTMLElement {
        const editor = el("textarea", {
            class: "editor",
            rows: "12",
            placeholder: "# My solution\n\n1. …\n\nMarkdown and $LaTeX$ both render on the glasses.",
        }) as HTMLTextAreaElement;
        try {
            editor.value = localStorage.getItem(DRAFT_KEY) ?? "";
        } catch {
            /* no draft to restore */
        }
        // Typing a page of maths into a phone and losing it to a backgrounded
        // tab is unrecoverable, so every keystroke is kept until it is saved.
        editor.addEventListener("input", () => {
            try {
                localStorage.setItem(DRAFT_KEY, editor.value);
            } catch {
                /* the draft simply won't persist */
            }
        });

        const saveState = status();
        const saveButton = el("button", {
            class: "btn primary",
            type: "button",
            text: "Save my solution",
        }) as HTMLButtonElement;

        saveButton.addEventListener("click", () => {
            const markdown = editor.value.trim();
            if (!markdown) return saveState.error("Nothing to save yet.");
            saveButton.disabled = true;
            saveState.info("Saving...");
            void (async () => {
                try {
                    const res = await fetch(`${MARKDOWN_SERVER_URL}/solution/mine`, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                            markdown,
                            notes: "written in the companion app",
                        }),
                    });
                    const saved = (await res.json()) as { ok: boolean; reason?: string };
                    if (!saved.ok) throw new Error(saved.reason ?? `HTTP ${res.status}`);
                    saveState.ok("Saved. It is on the glasses' AI page now, and in the Solution tab.");
                    // Once the server has it, a second local copy is only
                    // somewhere for the two to start disagreeing.
                    try {
                        localStorage.removeItem(DRAFT_KEY);
                    } catch {
                        /* nothing to do */
                    }
                } catch (err) {
                    saveState.error(
                        `Could not save: ${err instanceof Error ? err.message : String(err)}`,
                    );
                } finally {
                    saveButton.disabled = false;
                }
            })();
        });

        return el(
            "div",
            { class: "section" },
            el("h2", { text: "Your solution" }),
            el("p", {
                class: "muted",
                text: "Saving puts it on the glasses' AI page, next to what the reader transcribed.",
            }),
            editor,
            el("div", { class: "row" }, saveButton),
            saveState.node,
        );
    }

    return {
        mount,
        refresh: () => {
            void load();
            // A scan in progress rewrites this every few seconds. Polling only
            // while the tab is open, and only on the interval the glasses use,
            // keeps that visible without a second SSE connection per phone.
            if (timer) clearInterval(timer);
            timer = setInterval(() => {
                if (document.visibilityState === "visible") void load();
            }, POLL_INTERVAL_MS);
        },
    };
}
