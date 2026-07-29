// Tab 3 — your own answer: write it here, read it back here.
//
// ONE DOCUMENT, NOT A LOG. Saving replaces what was there, exactly like the
// Adri sheet — there is one answer you are working on, and a history of drafts
// is a list of things nobody asked to keep. That is also why it is stored as a
// document (slug my-solution) rather than as another row in the solve loop's
// `solutions` table: rows in that table are what the glasses' AI page shows,
// newest first whoever wrote it, so writing your own working used to hide
// Claude's. They are two pages now, Mine and AI, and neither covers the other.
//
// Editing and reading are the same tab because there is only one text. The
// editor is the view of it.
//
// IT SURVIVES THE NETWORK. Every keystroke goes to localStorage, the last
// server copy is cached there too, and a save that cannot reach the server is
// kept as pending and retried — on the next visit to the tab, when the browser
// says it is back online, and on a timer while you sit here. Nothing you type
// is lost to a dropped connection, and nothing on screen is a blank pane with
// an error over it while a perfectly good copy exists on the phone.

import { MARKDOWN_SERVER_URL, POLL_INTERVAL_MS } from "../constants";
import { ago } from "../utils";
import { offline, readCache, writeCache } from "./cache";
import { copyText, el, status } from "./dom";

/** Unsaved keystrokes, so a backgrounded tab can't eat a page of maths. */
const DRAFT_KEY = "evens.companion.draft";
/** A save that hasn't reached the server yet. */
const PENDING_KEY = "evens.companion.pending";
/** The last copy the server confirmed. */
const CACHE_KEY = "my-solution";

const DOC_URL = `${MARKDOWN_SERVER_URL}/doc/my-solution`;

interface StoredDoc {
    slug: string;
    markdown: string;
    saved: boolean;
    version: number;
    updated_at: number | null;
}

interface Pending {
    markdown: string;
    at: number;
}

function readPending(): Pending | null {
    try {
        const raw = localStorage.getItem(PENDING_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Pending;
        return typeof parsed?.markdown === "string" ? parsed : null;
    } catch {
        return null;
    }
}

function writePending(markdown: string): void {
    try {
        localStorage.setItem(PENDING_KEY, JSON.stringify({ markdown, at: Date.now() } satisfies Pending));
    } catch {
        /* the retry then only lives as long as this page does */
    }
}

function clearPending(): void {
    try {
        localStorage.removeItem(PENDING_KEY);
    } catch {
        /* nothing to do */
    }
}

export function mountSolutionTab(): {
    mount: (root: HTMLElement) => void;
    refresh: () => void;
} {
    const state = status();

    let editor: HTMLTextAreaElement;
    let meta: HTMLElement;
    let saveButton: HTMLButtonElement;
    let copyButton: HTMLButtonElement;
    let timer: ReturnType<typeof setInterval> | null = null;
    /** The server copy as we last knew it, cached or fetched. */
    let stored = "";
    /** True while a PUT is in flight, so the timer can't start a second one. */
    let sending = false;

    function describe(source: "server" | "cache", at: number | null, pending: Pending | null): void {
        const parts: string[] = [];
        if (pending) {
            parts.push(`Not synced — saved on this phone ${ago(pending.at)}`);
        } else if (!stored) {
            parts.push("Nothing saved yet");
        } else if (source === "cache") {
            parts.push(`Offline copy${at ? ` — server said this ${ago(at)}` : ""}`);
        } else {
            parts.push(at ? `Saved ${ago(at)}` : "Saved");
        }
        if (stored || pending) {
            parts.push(`${(pending?.markdown ?? stored).length} characters`);
        }
        // Said out loud, because the box showing text the server has never seen
        // and the box showing the saved document look identical.
        const draft = readDraft().trim();
        if (draft && draft !== (pending?.markdown.trim() ?? stored.trim())) {
            parts.push("unsaved edits in the box");
        }
        meta.textContent = parts.join(" · ");
        copyButton.disabled = !editor.value.trim();
    }

    /**
     * Show something immediately, then reconcile with the server.
     *
     * The cache is painted first on purpose: on a phone the fetch is the slow
     * part, and there is no reason to look at "Loading..." for text that is
     * already on the device.
     */
    async function load(): Promise<void> {
        const cached = readCache<StoredDoc>(CACHE_KEY);
        const pending = readPending();
        if (cached) {
            stored = cached.value.markdown ?? "";
            fill(pending?.markdown ?? stored);
            describe("cache", cached.value.updated_at ?? cached.at, pending);
        }

        try {
            const res = await fetch(DOC_URL);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const doc = (await res.json()) as StoredDoc;
            writeCache(CACHE_KEY, doc);
            stored = doc.markdown ?? "";
            // A pending save is newer than anything the server can be holding —
            // it was typed after the last load — so it stays in the box and the
            // fetch only refreshes what we compare against. The phone is the
            // only editor of this document, so there is no third party whose
            // edit we could be discarding.
            if (!pending) fill(stored);
            describe("server", doc.updated_at, pending);
            state.clear();
            if (pending) void flush(pending);
        } catch (err) {
            if (!cached) {
                fill(pending?.markdown ?? readDraft());
                describe("cache", null, pending);
            }
            state.error(
                offline()
                    ? "Offline — showing the copy stored on this phone."
                    : `Server unreachable (${err instanceof Error ? err.message : String(err)}) — showing the copy on this phone.`,
            );
        }
    }

    function readDraft(): string {
        try {
            return localStorage.getItem(DRAFT_KEY) ?? "";
        } catch {
            return "";
        }
    }

    /** Put text in the editor without stamping on what is being typed. */
    function fill(text: string): void {
        const draft = readDraft();
        // An unsaved draft beats both: it is the only text that exists nowhere
        // else, and a refresh that replaced it would be the one unrecoverable
        // thing this tab could do.
        const next = draft || text;
        if (document.activeElement === editor) return;
        if (editor.value !== next) editor.value = next;
    }

    /** Push a pending save. Silent about failure — the label already says. */
    async function flush(pending: Pending): Promise<boolean> {
        if (sending) return false;
        sending = true;
        try {
            const ok = await put(pending.markdown);
            if (!ok) return false;
            clearPending();
            stored = pending.markdown.trim();
            // The draft that produced this save has now been saved. Left
            // behind, it would win over the server's copy on every reload for
            // no reason — it is the same text.
            if (readDraft().trim() === stored) clearDraft();
            describe("server", Date.now(), null);
            state.ok("Synced — the save that was waiting is on the server now.");
            return true;
        } catch (err) {
            // The server refused it rather than failing to answer. Retrying
            // would refuse forever, so it stops being pending — the text is
            // still in the box, and the message says what to fix.
            clearPending();
            describe("cache", null, null);
            state.error(
                `The waiting save was refused: ${err instanceof Error ? err.message : String(err)}`,
            );
            return false;
        } finally {
            sending = false;
        }
    }

    async function put(markdown: string): Promise<boolean> {
        const res = await fetch(DOC_URL, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ markdown }),
        }).catch(() => null);
        if (!res) return false;
        const body = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            reason?: string;
            version?: number;
            updated_at?: number;
        };
        if (!res.ok || body.ok === false) {
            // A refusal is not a network problem: too long, or not a string.
            // Retrying it forever would never succeed, so it is reported and
            // the pending copy is dropped back to a draft.
            throw new Error(body.reason ?? `HTTP ${res.status}`);
        }
        // The server's own version and timestamp, so the cache is the document
        // as it exists there rather than our guess at it.
        writeCache(CACHE_KEY, {
            slug: "my-solution",
            markdown: markdown.trim(),
            saved: true,
            version: body.version ?? 0,
            updated_at: body.updated_at ?? Date.now(),
        } satisfies StoredDoc);
        return true;
    }

    async function save(): Promise<void> {
        const markdown = editor.value.trim();
        saveButton.disabled = true;
        state.info("Saving...");
        try {
            const ok = await put(markdown);
            if (ok) {
                stored = markdown;
                clearPending();
                clearDraft();
                describe("server", Date.now(), null);
                state.ok("Saved. It is on the glasses' Mine page now.");
            } else {
                // The request never landed. Keep it, say so, and let the retry
                // path deal with it — the alternative is telling someone who
                // just typed a page of maths that it failed and leaving them to
                // remember to press the button again.
                writePending(markdown);
                describe("cache", null, readPending());
                state.info(
                    offline()
                        ? "Offline — saved on this phone. It will sync by itself when you're back."
                        : "Server unreachable — saved on this phone. It will sync by itself.",
                );
            }
        } catch (err) {
            clearPending();
            state.error(`Refused: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            saveButton.disabled = false;
        }
    }

    function clearDraft(): void {
        try {
            localStorage.removeItem(DRAFT_KEY);
        } catch {
            /* nothing to do */
        }
    }

    function mount(root: HTMLElement): void {
        meta = el("p", { class: "muted" });

        editor = el("textarea", {
            class: "editor",
            rows: "14",
            placeholder: "# My solution\n\n1. …\n\nMarkdown and $LaTeX$ both render on the glasses.",
        }) as HTMLTextAreaElement;
        editor.value = readDraft();
        editor.addEventListener("input", () => {
            try {
                localStorage.setItem(DRAFT_KEY, editor.value);
            } catch {
                /* the draft simply won't survive a reload */
            }
            copyButton.disabled = !editor.value.trim();
        });

        saveButton = el("button", {
            class: "btn primary",
            type: "button",
            text: "Save",
        }) as HTMLButtonElement;
        saveButton.addEventListener("click", () => void save());

        copyButton = el("button", { class: "btn", type: "button", text: "Copy" }) as HTMLButtonElement;
        copyButton.disabled = true;
        copyButton.addEventListener("click", () => {
            void copyText(editor.value).then((done) =>
                done ? state.ok("Copied.") : state.error("Could not copy."),
            );
        });

        const reload = el("button", { class: "btn", type: "button", text: "Reload" }) as HTMLButtonElement;
        reload.addEventListener("click", () => void load());

        root.append(
            el("h2", { text: "My solution" }),
            el("p", {
                class: "muted",
                text: "One document — saving replaces it. It shows on the glasses' Mine page, separately from whatever Claude solved.",
            }),
            meta,
            editor,
            el("div", { class: "row" }, saveButton, copyButton, reload),
            state.node,
        );

        // The browser telling us the network is back is the cheapest retry
        // trigger there is, and the one that fires while you are looking at
        // something else. Registered once, for the life of the app.
        window.addEventListener("online", () => {
            const pending = readPending();
            if (pending) void flush(pending);
        });
    }

    return {
        mount,
        refresh: () => {
            void load();
            // A slow retry while the tab is open, so a save made in a dead spot
            // lands as soon as there is signal — without waiting for the
            // `online` event, which a captive portal or a flaky AP never sends.
            if (timer) clearInterval(timer);
            timer = setInterval(() => {
                if (document.visibilityState !== "visible") return;
                const pending = readPending();
                if (pending) void flush(pending);
            }, POLL_INTERVAL_MS);
        },
    };
}
