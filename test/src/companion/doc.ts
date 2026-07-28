// Tabs for the hand-written documents — the Adri pair.
//
// One factory, two tabs, because they are the same thing twice: a text area, a
// save button, and a note saying when it was last written. What differs is the
// slug and the words around it.
//
// THERE IS ONE OF EACH. Saving replaces what was there; the server keeps no
// history, and the version the glasses refetch on is a hash of the text, so an
// edit here is the update — the Adri page redraws on its own, and saving the
// same text twice costs nothing at all. That is the whole contract, and it is
// deliberately different from the Solve tab next door, where every save appends
// another solution to a list.

import { MARKDOWN_SERVER_URL } from "../constants";
import { ago } from "../utils";
import { copyText, el, status } from "./dom";

export type DocSlug = "adri-assignment" | "adri-solution";

interface StoredDoc {
    slug: DocSlug;
    markdown: string;
    saved: boolean;
    version: number;
    updated_at: number | null;
}

interface DocTabOptions {
    slug: DocSlug;
    heading: string;
    /** One line under the heading: what this document is for. */
    blurb: string;
    placeholder: string;
}

export function mountDocTab(opts: DocTabOptions): {
    mount: (root: HTMLElement) => void;
    refresh: () => void;
} {
    const state = status();
    const draftKey = `evens.companion.doc.${opts.slug}`;

    let editor: HTMLTextAreaElement;
    let meta: HTMLElement;
    let saveButton: HTMLButtonElement;
    /** What the server last told us it holds, to spot an unsaved edit. */
    let stored = "";

    function describe(doc: StoredDoc | null): void {
        if (!doc || !doc.saved) {
            meta.textContent = "Not written yet.";
            return;
        }
        meta.textContent = `Saved ${doc.updated_at ? ago(doc.updated_at) : "recently"} · ${
            doc.markdown.length
        } characters · version ${doc.version}`;
    }

    function markDirty(): void {
        const dirty = editor.value.trim() !== stored;
        saveButton.textContent = dirty ? "Save changes" : "Saved";
        saveButton.disabled = !dirty;
        try {
            if (dirty) localStorage.setItem(draftKey, editor.value);
            else localStorage.removeItem(draftKey);
        } catch {
            /* the draft simply won't persist */
        }
    }

    async function load(): Promise<void> {
        try {
            const res = await fetch(`${MARKDOWN_SERVER_URL}/doc/${opts.slug}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const doc = (await res.json()) as StoredDoc;
            stored = doc.markdown ?? "";

            // An unsaved draft wins over the server's copy. Overwriting what you
            // typed with what you last saved — because a tab regained focus — is
            // the one way this screen could lose work.
            let draft: string | null = null;
            try {
                draft = localStorage.getItem(draftKey);
            } catch {
                /* no draft */
            }
            if (draft !== null && draft.trim() !== stored) {
                editor.value = draft;
                state.info("Showing an unsaved draft. Save it, or reload to discard.");
            } else if (document.activeElement !== editor) {
                // Only when you are not typing in it: replacing the contents
                // under a cursor is worse than being one save behind.
                editor.value = stored;
            }
            describe(doc);
            markDirty();
        } catch (err) {
            state.error(err instanceof Error ? err.message : String(err));
        }
    }

    async function save(): Promise<void> {
        saveButton.disabled = true;
        state.info("Saving...");
        try {
            const res = await fetch(`${MARKDOWN_SERVER_URL}/doc/${opts.slug}`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ markdown: editor.value }),
            });
            const body = (await res.json()) as { ok: boolean; reason?: string; version?: number };
            if (!body.ok) throw new Error(body.reason ?? `HTTP ${res.status}`);
            stored = editor.value.trim();
            state.ok(`Saved — version ${body.version}. The glasses have it.`);
            await load();
        } catch (err) {
            state.error(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
            saveButton.disabled = false;
        }
    }

    function mount(root: HTMLElement): void {
        meta = el("p", { class: "muted" });

        editor = el("textarea", {
            class: "editor",
            rows: "16",
            placeholder: opts.placeholder,
        }) as HTMLTextAreaElement;
        editor.addEventListener("input", markDirty);

        saveButton = el("button", {
            class: "btn primary",
            type: "button",
            text: "Save changes",
        }) as HTMLButtonElement;
        saveButton.disabled = true;
        saveButton.addEventListener("click", () => void save());

        const copy = el("button", { class: "btn", type: "button", text: "Copy" }) as HTMLButtonElement;
        copy.addEventListener("click", () => {
            void copyText(editor.value).then((done) =>
                done ? state.ok("Copied.") : state.error("Could not copy."),
            );
        });

        const reload = el("button", { class: "btn", type: "button", text: "Reload" }) as HTMLButtonElement;
        reload.addEventListener("click", () => {
            try {
                localStorage.removeItem(draftKey);
            } catch {
                /* nothing to do */
            }
            editor.value = stored;
            markDirty();
            void load();
        });

        root.append(
            el("h2", { text: opts.heading }),
            el("p", { class: "muted", text: opts.blurb }),
            meta,
            editor,
            el("div", { class: "row" }, saveButton, copy, reload),
            state.node,
        );
    }

    return { mount, refresh: () => void load() };
}
