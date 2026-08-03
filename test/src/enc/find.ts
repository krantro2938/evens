// "По заданию": which topics does the paper in front of you actually need?
//
// The camera has already read the assignment and the server already holds it as
// markdown. Matching that against the pack's own term index turns "somewhere in
// seventeen articles" into three rows — which is the difference between the
// encyclopedia being a reference and being a thing you browse when you have
// time, and you do not have time.
//
// The matching runs HERE, not on the server. The index is 1789 terms and lives
// in a file the client has already downloaded; a /enc/find endpoint would be a
// round trip, a second implementation to keep in step across two backends, and
// one more thing that stops working when the servers do.

import { docFetch } from "../services/backend";
import { appLog } from "../debug";
import type { Toc } from "./pack";

/** How many topics to offer. More than this and it is a syllabus, not a hint. */
const MAX_RESULTS = 8;

/**
 * The prefix length the packer indexed at.
 *
 * Russian is heavily inflected and there is no stemmer on either side, so
 * "интегралов", "интегралы" and "интеграл" have to collapse to one key. Six
 * characters does that without merging words that only look alike. MUST MATCH
 * tools/enc/pack.ts — a different length here matches nothing at all, silently.
 */
const STEM = 6;

const stems = (text: string): string[] =>
    text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, " ")
        .split(/\s+/)
        .filter((word) => word.length >= 4)
        .map((word) => word.slice(0, STEM));

async function assignmentText(): Promise<string> {
    try {
        const res = await docFetch("/assignment/markdown");
        if (!res.ok) return "";
        const body = (await res.json()) as { content?: string };
        // Formulas contribute nothing searchable — the index is built from
        // prose, and "x^2" matches every topic or none.
        return (body.content ?? "").replace(/\$[^$]*\$/g, " ");
    } catch (err) {
        appLog("Enc", "assignment fetch failed", err);
        return "";
    }
}

/**
 * Rank the tree against the assignment.
 *
 * Scored by how many DISTINCT terms hit a node rather than by raw frequency: a
 * paper that says "интеграл" nine times is one problem about integrals, and
 * frequency would let it drown out the two other problems on the sheet.
 */
export async function matchAssignment(toc: Toc | null): Promise<string[]> {
    if (!toc) return [];
    const text = await assignmentText();
    if (!text.trim()) return [];

    const scores = new Map<string, number>();
    for (const stem of new Set(stems(text))) {
        for (const id of toc.index[stem] ?? []) {
            scores.set(id, (scores.get(id) ?? 0) + 1);
        }
    }
    if (!scores.size) return [];

    // A single shared word is a coincidence at this stem length; two is a
    // topic. The floor drops to one only when nothing clears it, because an
    // uncertain answer still beats an empty list you cannot tell from a bug.
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const strong = ranked.filter(([, score]) => score >= 2);
    return (strong.length ? strong : ranked).slice(0, MAX_RESULTS).map(([id]) => id);
}
