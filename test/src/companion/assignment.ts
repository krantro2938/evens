// Tab 2 — what the reader made of the sheet.
//
// The same markdown the glasses render into tiles, as text you can select,
// scroll and copy. That last one is the point: the transcription is the input
// to whatever you actually solve the paper with, and until now the only way to
// get it off the glasses was to ask the server for it yourself.
//
// Read-only, and cached. The answer you write is the Solution tab now — it is
// its own document rather than a box under the question, because it is a thing
// you come back to and edit, not something you dash off while reading. The
// transcription itself is mirrored to localStorage on every successful load, so
// the paper is still readable on a phone that has lost the server.

import { MARKDOWN_SERVER_URL, POLL_INTERVAL_MS } from "../constants";
import { ago } from "../utils";
import { offline, readCache, writeCache } from "./cache";
import { copyText, el, status } from "./dom";

/** The last transcription the server confirmed, for when it can't be reached. */
const CACHE_KEY = "assignment";

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

            let described: string | null = null;
            if (statusRes.ok) {
                const s = (await statusRes.json()) as AssignmentStatus;
                described = describe(s);
                meta.textContent = described;
            }
            // Cached only on the good path, so the fallback is always a whole
            // transcription the server actually served — never a half-read one.
            writeCache(CACHE_KEY, { content: text, described });
            state.clear();
        } catch (err) {
            showCached(err);
        }
    }

    /**
     * The server is unreachable. Show the last copy rather than an error over an
     * empty pane — the transcription does not go stale quickly, and reading the
     * paper is the entire reason this tab exists.
     */
    function showCached(err: unknown): void {
        const cached = readCache<{ content: string; described: string | null }>(CACHE_KEY);
        if (cached) {
            text = cached.value.content ?? "";
            body.textContent = text || "Nothing transcribed yet.";
            copyButton.disabled = !text;
            meta.textContent = `Offline copy — read ${ago(cached.at)}${
                cached.value.described ? ` · ${cached.value.described}` : ""
            }`;
        }
        state.error(
            offline()
                ? `Offline${cached ? " — showing the copy stored on this phone." : " — nothing cached on this phone yet."}`
                : `${err instanceof Error ? err.message : String(err)}${
                      cached ? " — showing the copy stored on this phone." : ""
                  }`,
        );
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
