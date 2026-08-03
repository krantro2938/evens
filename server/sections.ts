// Splitting a solution document into per-problem sections, and putting a
// corrected one back.
//
// This exists because of what a re-solve is. When the reviewer says problem 4 is
// wrong, the thing to fix is problem 4 — not to hand the whole paper back to a
// model and hope the six problems it already got right survive the retelling.
// So a revision run asks for those sections alone and this splices them in, and
// every other problem in the document is preserved BYTE FOR BYTE. Work that has
// been graded and passed is never silently rewritten.
//
// The contract it leans on is one the solve prompt has always stated: "one `##`
// heading per problem, numbered as the assignment numbers them". That makes the
// heading's number a stable key into the document, which is the whole trick.
// Everything before the first `##` (the title, any preamble) is untouched, and
// so is anything after the last problem.

/** One `##` section of a solution document. */
export interface Section {
    /**
     * The problem number as it appears in the heading, normalised: `## 4.
     * Интеграл` and `## Задача 4` both key as `4`, and `## 12б)` as `12б`. Null
     * when the heading carries no number — an appendix, a closing note — which
     * is a section that exists but cannot be targeted.
     */
    key: string | null;
    /** The `##` line itself. */
    heading: string;
    /** Heading and body together, exactly as they appear, trailing blank lines trimmed. */
    text: string;
}

export interface Document {
    /** Everything above the first `##`, usually the `#` title. */
    preamble: string;
    sections: Section[];
}

/**
 * The number in a heading, or null.
 *
 * The FIRST digit run wins, so `## 4. Найдите x_1` is problem 4 rather than
 * problem 1. A trailing letter is part of the key (`12b`, `4б`) because a paper
 * that splits a problem into parts numbers them that way and they are graded
 * separately.
 */
export function headingKey(heading: string): string | null {
    const text = heading.replace(/^#+\s*/, "");
    const m = /(\d+)\s*([a-zA-Zа-яА-Я])?\)?/.exec(text);
    if (!m) return null;
    return (m[1]! + (m[2] ?? "")).toLowerCase();
}

/** Loose equality for keys, so `4` matches `4.` and `4)` and ` 4 `. */
function sameKey(a: string, b: string): boolean {
    const clean = (s: string) => s.trim().toLowerCase().replace(/[.\s)]+$/, "");
    return clean(a) === clean(b);
}

/**
 * Split a document at its `##` headings.
 *
 * Fenced blocks are tracked, because a ```viz figure holds JSON and a document
 * that happened to contain a `## ` line inside a fence would otherwise be cut in
 * the middle of a figure the paginator then cannot place.
 */
export function splitSections(markdown: string): Document {
    const lines = markdown.split("\n");
    const preamble: string[] = [];
    const sections: Section[] = [];
    let current: { heading: string; body: string[] } | null = null;
    let fence: string | null = null;

    const flush = () => {
        if (!current) return;
        const text = [current.heading, ...current.body].join("\n").replace(/\s+$/, "");
        sections.push({ key: headingKey(current.heading), heading: current.heading, text });
        current = null;
    };

    for (const line of lines) {
        const fenceMark = /^\s*(`{3,}|~{3,})/.exec(line);
        if (fenceMark) {
            // Closing only on the same fence character, so a ``` inside a ~~~
            // block doesn't end it.
            if (fence === null) fence = fenceMark[1]![0]!;
            else if (fenceMark[1]![0] === fence) fence = null;
        }

        if (fence === null && /^##\s+\S/.test(line)) {
            flush();
            current = { heading: line, body: [] };
            continue;
        }
        if (current) current.body.push(line);
        else preamble.push(line);
    }
    flush();

    return { preamble: preamble.join("\n").replace(/\s+$/, ""), sections };
}

export interface SpliceResult {
    ok: boolean;
    markdown?: string;
    /** Keys the caller did not ask to be changed. */
    unexpected?: string[];
    /** Keys that replaced an existing section, in document order. */
    replaced?: string[];
    /** Keys that were not in the document and have been inserted. */
    added?: string[];
}

export interface SpliceOptions {
    /**
     * The problem numbers this submission is allowed to touch — on a revision
     * run, the ones the reviewer sent back.
     *
     * Anything else is REFUSED rather than applied. A revision is not an
     * opportunity to rewrite the paper: the problems that are not in this list
     * have been graded and passed, and letting an agent quietly replace one
     * would put unreviewed text on the glasses under a score that was never
     * about it. Omit the option to allow any key that matches.
     */
    allowed?: readonly string[];
}

/** The numeric part of a key, for ordering. `12б` sorts as 12. */
function keyOrder(key: string): number {
    const m = /\d+/.exec(key);
    return m ? Number(m[0]) : Number.MAX_SAFE_INTEGER;
}

/**
 * Replace — or insert — whole sections of `base` by problem number.
 *
 * The replacement is taken as given, heading included. It is the agent's
 * section, so it decides how the heading reads; all this owns is where it goes.
 *
 * A requested key that matches no heading is INSERTED in numeric order rather
 * than refused, because there is a real case for it: a problem the assignment
 * poses and the first pass never answered at all. The reviewer scores that 0,
 * it fails its band, and the revision that fixes it is necessarily adding a
 * section rather than replacing one. A key that was not requested is still
 * refused — see `allowed`.
 */
export function spliceSections(
    base: string,
    replacements: Record<string, string>,
    opts: SpliceOptions = {},
): SpliceResult {
    const doc = splitSections(base);
    const keys = Object.keys(replacements);
    if (keys.length === 0) return { ok: false, unexpected: [] };

    if (opts.allowed) {
        const unexpected = keys.filter(
            (k) => !opts.allowed!.some((a) => sameKey(a, k)),
        );
        if (unexpected.length) return { ok: false, unexpected };
    }

    const replaced: string[] = [];
    const added: string[] = [];

    for (const key of keys) {
        const text = replacements[key]!.replace(/\s+$/, "");
        const hit = doc.sections.find((s) => s.key !== null && sameKey(s.key, key));
        if (hit) {
            hit.text = text;
            replaced.push(hit.key!);
            continue;
        }
        // New: place it where its number belongs, so the document still reads in
        // the paper's order rather than with problem 3 tacked on after 7.
        const at = doc.sections.findIndex(
            (s) => s.key !== null && keyOrder(s.key) > keyOrder(key),
        );
        const section: Section = { key, heading: text.split("\n")[0] ?? "", text };
        if (at === -1) doc.sections.push(section);
        else doc.sections.splice(at, 0, section);
        added.push(key);
    }

    const parts = doc.preamble ? [doc.preamble] : [];
    for (const s of doc.sections) parts.push(s.text);
    return { ok: true, markdown: parts.join("\n\n") + "\n", replaced, added };
}

/** The problem numbers a document actually contains, for an error message. */
export function sectionKeys(markdown: string): string[] {
    return splitSections(markdown)
        .sections.map((s) => s.key)
        .filter((k): k is string => k !== null);
}

/**
 * Add a line to the end of each section.
 *
 * Used to hang the grader's verdict off each problem, right under the answer it
 * is about (see `withRatings` in review.ts). Rebuilt through the same split as
 * the splice, so a `##` inside a fenced figure is not mistaken for a heading and
 * a document with no problems at all comes back untouched.
 *
 * `note` returning null leaves a section exactly as it was, which is what an
 * ungraded problem gets — silence rather than a placeholder.
 */
export function annotateSections(
    markdown: string,
    note: (key: string | null) => string | null,
): string {
    const doc = splitSections(markdown);
    if (doc.sections.length === 0) return markdown;

    let touched = false;
    const parts = doc.preamble ? [doc.preamble] : [];
    for (const s of doc.sections) {
        const line = note(s.key);
        if (line === null) {
            parts.push(s.text);
            continue;
        }
        touched = true;
        parts.push(`${s.text}\n\n${line}`);
    }
    // Byte-identical when nothing matched, so an ungraded solution keeps its
    // content hash and costs no re-render and no BLE push.
    return touched ? parts.join("\n\n") + "\n" : markdown;
}
