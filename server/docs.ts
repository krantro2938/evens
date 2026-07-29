// Hand-written documents: the ones you type rather than the ones a camera or an
// agent produces.
//
// Everything else this server shows is derived — solution.md is a file, the
// assignment comes off the reader, the AI page is whatever Claude last
// submitted. These are neither: a sheet you state yourself (Adri), an answer
// you write yourself, and the glasses are only there to read it back to you.
//
// `my-solution` is your working on the assignment the CAMERA read, and it is a
// document here rather than a row in `solutions` for two reasons. It is one
// thing you edit, not an attempt log — saving replaces it, exactly like Adri.
// And a `solutions` row is what the AI page shows (newest wins, whoever wrote
// it), so writing your own answer used to overwrite Claude's on the glasses.
// Yours and the agent's are now two documents on two pages, and neither hides
// the other.
//
// It costs almost no code because a DocSource is the only thing the rendering
// pipeline knows about (see doc.ts). Give it markdown and a version that moves
// when the markdown does, and the tile cache, the SSE fan-out and the client's
// paging all work unchanged.

import { hashContent, type DocSource, type Snapshot } from "./doc";
import { getDoc, putDoc } from "./db";

/**
 * The documents that exist. A fixed list, not "any slug you POST":
 *
 * every slug is a page on the glasses and a tab in the companion app, both of
 * which are built at compile time — so a slug nothing renders is a document you
 * can write and never see, and an open endpoint would let a typo create one
 * silently.
 */
export const DOC_SLUGS = ["adri-assignment", "adri-solution", "my-solution"] as const;
export type DocSlug = (typeof DOC_SLUGS)[number];

export function isDocSlug(value: string): value is DocSlug {
    return (DOC_SLUGS as readonly string[]).includes(value);
}

/** Refuse a document that would take minutes to render into tiles. */
const MAX_DOC_CHARS = Number(process.env.DOC_MAX_CHARS ?? 200_000);

/** What an empty slug reads as, so the glasses have something to say. */
const PLACEHOLDER: Record<DocSlug, string> = {
    "adri-assignment": "# Adri\n\nNothing set yet.\n\nWrite the assignment in the companion app.",
    "adri-solution": "# Adri\n\nNo solution yet.\n\nWrite one in the companion app.",
    "my-solution": "# My solution\n\nNothing written yet.\n\nWrite one in the companion app.",
};

const listeners = new Map<DocSlug, Set<() => void>>();

function notify(slug: DocSlug): void {
    for (const fn of listeners.get(slug) ?? []) fn();
}

export interface SaveResult {
    ok: boolean;
    reason?: string;
    version?: number;
    updated_at?: number;
    /**
     * Whether the text actually differs from what was stored.
     *
     * The caller uses it to decide whether to act on the save — publishing the
     * Adri task upstream archives a version, and doing that for a save that
     * changed nothing would fill the archive with identical copies every time
     * you pressed the button twice.
     */
    changed?: boolean;
}

/**
 * Replace a document. There is exactly one of each, and this is the edit.
 *
 * The version is a hash of the content, so saving the same text twice is a
 * no-op all the way down: no render, no tile push, no BLE. Saving different
 * text changes the version, which is the whole mechanism by which the glasses
 * notice — a page open on the Adri document redraws without being asked.
 */
export function saveDoc(slug: DocSlug, markdown: string): SaveResult {
    const text = markdown.trim();
    if (text.length > MAX_DOC_CHARS) {
        return { ok: false, reason: `too_long_${text.length}` };
    }
    // An empty save is allowed and means "clear it" — the placeholder comes
    // back, which is a state you can get out of. Refusing would leave the only
    // way to undo a paste being to select it all and type something.
    const before = getDoc(slug)?.markdown?.trim() ?? "";
    const row = putDoc(slug, text);
    notify(slug);
    console.log(`[docs] ${slug} saved: ${text.length} chars`);
    return {
        ok: true,
        version: hashContent(text || PLACEHOLDER[slug]),
        updated_at: row.updated_at,
        changed: before !== text,
    };
}

export interface StoredDoc {
    slug: DocSlug;
    markdown: string;
    /** Empty and never written are the same thing to a reader; this is not. */
    saved: boolean;
    version: number;
    updated_at: number | null;
}

export function readDoc(slug: DocSlug): StoredDoc {
    const row = getDoc(slug);
    const markdown = row?.markdown?.trim() ?? "";
    return {
        slug,
        markdown,
        saved: Boolean(row),
        // The placeholder is hashed, not the empty string, so the version tracks
        // what is actually rendered — otherwise clearing a document would leave
        // the glasses showing the old tiles at a version that never changed.
        version: hashContent(markdown || PLACEHOLDER[slug]),
        updated_at: row?.updated_at ?? null,
    };
}

/** The DocSource the tile pipeline and the SSE stream are built on. */
export function docSource(slug: DocSlug): DocSource {
    return {
        name: slug,
        async read(): Promise<Snapshot> {
            const doc = readDoc(slug);
            return { content: doc.markdown || PLACEHOLDER[slug], version: doc.version };
        },
        subscribe(onChange: () => void): () => void {
            let set = listeners.get(slug);
            if (!set) {
                set = new Set();
                listeners.set(slug, set);
            }
            set.add(onChange);
            return () => set!.delete(onChange);
        },
    };
}
