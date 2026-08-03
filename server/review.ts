// The review loop: a second agent that grades the first one's answer, and sends
// back the problems that aren't good enough.
//
//   /solution/submit lands ──▶ startReview()
//                                mints a review + a one-time token, kicks the
//                                reviewer routine (trigger.ts)
//
//   the reviewer ──▶ GET  /review/claim    the assignment, the solution, the rubric
//                ──▶ POST /review/submit   points per problem
//
//   submitReview() ──▶ the failures, if any, become a REVISION RUN on the
//                      ordinary solve queue: same tokens, same routine, but
//                      scoped to those problems and carrying what the reviewer
//                      said about each. Its answer is spliced into the solution
//                      (sections.ts) and reviewed again, up to REVIEW_MAX_ROUNDS.
//
// WHY A SEPARATE AGENT AT ALL. A model checking its own work re-derives it the
// same way and agrees with itself; a model handed a finished solution and told
// to find what a grader would take marks off for is doing a different, easier
// job. So the reviewer never sees the solver's reasoning — only the paper and
// the finished document, exactly as a marker would.
//
// WHY THE SERVER DECIDES WHAT GETS RE-SOLVED. The reviewer reports facts: points
// per problem, and whether the final answer is right. The thresholds that turn
// those into "do it again" live here, in one place, in code — not in a prompt
// that can be reasoned around by an agent reluctant to send work back.

import {
    activeReview,
    cancelActiveReviews,
    claimNextReview,
    createReview,
    finishReview,
    latestReview,
    latestReviewFor,
    recordReviewTrigger,
    reviewBefore,
    reviewByToken,
    runById,
    solutionById,
    type ReviewRow,
    type RunRow,
    type SolutionRow,
} from "./db";
import { annotateSections, sectionKeys } from "./sections";
import { reviewConfigured, reviewTriggerDescription, runReviewRoutine } from "./trigger";

// ── the rubric ──────────────────────────────────────────────────────────────
//
// Two bands, because two kinds of problem are graded by different rules and a
// single number for both would be a lie about one of them.
//
//   answer  the easy ones at the front of the paper. Only the final answer is
//           graded, so the whole 15 rides on it and the pass condition is not a
//           score at all: the answer is right or the problem goes back.
//   method  the ones where the working IS the mark. 18 available, of which only
//           5 for arriving at the right number — the other 13 are for the
//           domain check, the named theorem, the justified division, the
//           screened root. A correct answer with an unargued middle scores 5
//           and fails; a well-argued attempt that slips in the arithmetic
//           scores well and may pass. That asymmetry is deliberate and it is
//           the reason this loop exists.
//
// WHICH PROBLEM IS IN WHICH BAND is positional by default — the first
// REVIEW_ANSWER_BAND problems of the document — because that is how the papers
// this was built for are laid out. When a paper explicitly marks its parts
// (ЧАСТЬ А / ЧАСТЬ В, «развёрнутое решение»), the reviewer is allowed to say so
// and its reading wins: an explicit marking on the sheet is better evidence
// than a positional guess. That is the ONLY thing about the rubric it may move.

const cfg = {
    /** How many problems at the front of the paper are answer-band. */
    answerBand: Number(process.env.REVIEW_ANSWER_BAND ?? 3),
    answerMax: Number(process.env.REVIEW_ANSWER_MAX ?? 15),
    methodMax: Number(process.env.REVIEW_METHOD_MAX ?? 18),
    /** Of methodMax, how much a correct final answer is worth on its own. */
    methodAnswerPoints: Number(process.env.REVIEW_METHOD_ANSWER_POINTS ?? 5),
    /** A method-band problem below this goes back for another attempt. */
    methodPass: Number(process.env.REVIEW_METHOD_PASS ?? 13),
    /**
     * Total attempts at any one problem, first pass included. 3 means: solve,
     * then at most two re-solves. THE ONLY THING BOUNDING WHAT THIS LOOP SPENDS
     * — every round is one solver session and one reviewer session, and a
     * problem the two disagree about permanently would otherwise run forever.
     */
    maxRounds: Number(process.env.REVIEW_MAX_ROUNDS ?? 3),
    /** Off switch that leaves the routine configured. Reviews nothing when 0. */
    enabled: (process.env.REVIEW_ENABLED ?? "1") !== "0",
};

export type Band = "answer" | "method";

export interface BandRule {
    band: Band;
    max: number;
    /** Points reserved for the final answer being right. */
    answer_points: number;
    /** Points for the working. Zero in the answer band — nothing else is graded. */
    method_points: number;
    /** What this band demands to pass, in the words the reviewer is held to. */
    pass: string;
}

export function bandRule(band: Band): BandRule {
    return band === "answer"
        ? {
              band,
              max: cfg.answerMax,
              answer_points: cfg.answerMax,
              method_points: 0,
              pass: "the final answer is correct AND in the form the paper asks for",
          }
        : {
              band,
              max: cfg.methodMax,
              answer_points: cfg.methodAnswerPoints,
              method_points: cfg.methodMax - cfg.methodAnswerPoints,
              pass: `at least ${cfg.methodPass} of ${cfg.methodMax} points`,
          };
}

/** The default band for a problem at position `index` (0-based) in the paper. */
export function defaultBand(index: number): Band {
    return index < cfg.answerBand ? "answer" : "method";
}

export interface RubricEntry {
    /** The problem number as the solution's headings give it. */
    id: string;
    band: Band;
    max: number;
    answer_points: number;
    method_points: number;
    pass: string;
}

/**
 * The rubric for one solution, keyed by the problem numbers the document
 * actually uses — so the reviewer grades against the paper's own numbering and
 * a re-solve can be addressed to a heading that exists (see sections.ts).
 */
export function rubricFor(solutionMarkdown: string): RubricEntry[] {
    return sectionKeys(solutionMarkdown).map((id, i) => {
        const rule = bandRule(defaultBand(i));
        return { id, ...rule };
    });
}

export function rubricSummary(): string {
    return (
        `first ${cfg.answerBand} problem(s): ${cfg.answerMax} points, answer-only, ` +
        `must be correct · the rest: ${cfg.methodMax} points ` +
        `(${cfg.methodAnswerPoints} answer + ${cfg.methodMax - cfg.methodAnswerPoints} method), ` +
        `pass at ${cfg.methodPass} · up to ${cfg.maxRounds} round(s)`
    );
}

export function isEnabled(): boolean {
    return cfg.enabled && reviewConfigured();
}

export function description(): string {
    if (!cfg.enabled) return "disabled (REVIEW_ENABLED=0)";
    if (!reviewConfigured()) return reviewTriggerDescription();
    return `${reviewTriggerDescription()} — ${rubricSummary()}`;
}

// ── timeouts ────────────────────────────────────────────────────────────────

const CLAIMED_TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS ?? 20 * 60_000);
const QUEUED_TIMEOUT_MS = Number(process.env.REVIEW_QUEUE_TIMEOUT_MS ?? 3 * 3600_000);

/** Same self-healing as the solve queue: a review nobody finishes must not read
 *  as "grading" forever. */
function expireStaleReview(): boolean {
    const review = activeReview();
    if (!review) return false;
    const age = Date.now() - (review.claimed_at ?? review.created_at);
    const limit = review.state === "claimed" ? CLAIMED_TIMEOUT_MS : QUEUED_TIMEOUT_MS;
    if (age < limit) return false;

    const what =
        review.state === "claimed"
            ? `the reviewer claimed this ${Math.round(age / 60_000)}m ago and never submitted`
            : `no reviewer picked this up in ${Math.round(age / 60_000)}m`;
    finishReview(review.id, "failed", null, `timed out: ${what}`);
    console.warn(`[review] review ${review.id} timed out (${review.state})`);
    return true;
}

const listeners = new Set<() => void>();

export function subscribeReview(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function notify(): void {
    for (const fn of listeners) fn();
}

setInterval(() => {
    if (expireStaleReview()) notify();
}, 60_000).unref?.();

// ── the verdict ─────────────────────────────────────────────────────────────

/** One problem, as the reviewer graded it. */
export interface ProblemVerdict {
    id: string;
    band: Band;
    points: number;
    max: number;
    /** Whether the final answer is right. The whole pass rule in the answer band. */
    answer_correct: boolean;
    /** What was wrong, for a person reading the footer. */
    notes: string;
    /** What the next attempt must do differently. Goes to the solver verbatim. */
    fix: string;
    /** Set here, not by the reviewer: whether this problem goes back. */
    resolve: boolean;
}

export interface Verdict {
    total: number;
    max_total: number;
    problems: ProblemVerdict[];
    summary: string;
    model: string | null;
    /** Problem ids that failed their band's rule. */
    failed: string[];
}

/**
 * Turn what the reviewer posted into a verdict, applying the thresholds here
 * rather than trusting a `resolve` flag from the agent.
 *
 * Tolerant about shape and strict about meaning: a missing `points` is 0 (a
 * problem the reviewer could not grade has not been shown to be right), and a
 * missing `answer_correct` is false for the same reason. The failure mode this
 * guards is a malformed submission quietly reading as a pass.
 */
export function gradeVerdict(raw: unknown, rubric: RubricEntry[]): Verdict | string {
    const body = (raw ?? {}) as Record<string, unknown>;
    const list = Array.isArray(body.problems) ? body.problems : null;
    if (!list || list.length === 0) return "problems must be a non-empty array";

    const byId = new Map(rubric.map((r) => [r.id.toLowerCase(), r]));
    const problems: ProblemVerdict[] = [];
    const failed: string[] = [];

    for (const item of list) {
        const p = (item ?? {}) as Record<string, unknown>;
        const id = String(p.id ?? p.problem ?? "").trim();
        if (!id) return "every problem needs an id";

        // The reviewer may move a problem between bands, and only that — see the
        // note at the top. Anything else about the band comes from the rubric.
        const declared = p.band === "answer" || p.band === "method" ? (p.band as Band) : null;
        const rule = bandRule(declared ?? byId.get(id.toLowerCase())?.band ?? "method");

        const points = Math.max(0, Math.min(rule.max, Math.round(Number(p.points) || 0)));
        const answerCorrect = p.answer_correct === true;
        const resolve =
            rule.band === "answer" ? !answerCorrect : points < cfg.methodPass;

        if (resolve) failed.push(id);
        problems.push({
            id,
            band: rule.band,
            points,
            max: rule.max,
            answer_correct: answerCorrect,
            notes: String(p.notes ?? "").slice(0, 4000),
            fix: String(p.fix ?? p.notes ?? "").slice(0, 4000),
            resolve,
        });
    }

    return {
        total: problems.reduce((n, p) => n + p.points, 0),
        max_total: problems.reduce((n, p) => n + p.max, 0),
        problems,
        summary: String(body.summary ?? "").slice(0, 4000),
        model: typeof body.model === "string" ? body.model : null,
        failed,
    };
}

// ── starting a review ───────────────────────────────────────────────────────

export interface StartReviewResult {
    ok: boolean;
    review_id?: number;
    detail?: string;
}

/**
 * Grade a solution. Called from submitSolution once the answer is safely stored,
 * so a reviewer that never runs costs the solution nothing.
 *
 * Never throws and never blocks the submit: a review is an improvement on an
 * answer that is already on the glasses, and a solve that lands is not allowed
 * to fail because the grader is misconfigured.
 */
export async function startReview(
    solution: SolutionRow,
    run: RunRow | null,
): Promise<StartReviewResult> {
    if (!isEnabled()) {
        return { ok: false, detail: description() };
    }

    const round = run?.round ?? 1;
    const review = createReview({
        token: crypto.randomUUID(),
        solution_id: solution.id,
        run_id: run?.id ?? null,
        round,
    });
    notify();

    const trigger = await runReviewRoutine(
        `A solution is waiting to be graded: review ${review.id}, ` +
            `solution ${solution.id}, round ${round} of ${cfg.maxRounds}. Claim it.`,
    );
    recordReviewTrigger(review.id, trigger.state, trigger.detail);
    notify();

    if (trigger.state === "triggered") {
        console.log(`[review] review ${review.id} triggered (${trigger.detail})`);
        return { ok: true, review_id: review.id };
    }
    console.log(
        `[review] review ${review.id} queued — trigger ${trigger.state}: ${trigger.detail}`,
    );
    return { ok: true, review_id: review.id, detail: trigger.detail ?? undefined };
}

/**
 * Stand down any grading in flight.
 *
 * Called when a fresh solve starts: that review is about a solution the person
 * has just decided to replace, and its verdict — arriving minutes later against
 * a document nobody is looking at any more — would trigger a revision of the
 * wrong paper.
 */
export function cancelReviews(reason: string): number {
    const n = cancelActiveReviews(reason.slice(0, 200));
    if (n) {
        console.log(`[review] ${n} review(s) stood down: ${reason}`);
        notify();
    }
    return n;
}

// ── the reviewer's side ─────────────────────────────────────────────────────

export interface ReviewClaim {
    ok: boolean;
    reason?: string;
    review_id?: number;
    review_token?: string;
    round?: number;
    max_rounds?: number;
    assignment?: { markdown: string; version: number | null; complete: boolean };
    solution?: { id: number; markdown: string; model: string | null };
    rubric?: {
        problems: RubricEntry[];
        note: string;
    };
    /** What the last round asked for, so a re-review can check the fix landed. */
    previous?: { round: number; total: number; max_total: number; problems: unknown } | null;
}

export function claimReview(): ReviewClaim {
    const review = claimNextReview();
    if (!review) return { ok: false, reason: "no_pending_review" };

    const solution = solutionById(review.solution_id);
    if (!solution) {
        // Cannot happen through the normal path (a review is created from a row
        // that was just inserted), so if it does the review is unanswerable and
        // must not sit in `claimed` until the timeout.
        finishReview(review.id, "failed", null, `solution ${review.solution_id} is gone`);
        notify();
        return { ok: false, reason: "solution_missing" };
    }

    notify();
    console.log(`[review] review ${review.id} claimed (solution ${solution.id})`);

    // The paper as it stood when the button was pressed, not a fresh read: the
    // answer has to be graded against the sheet it was written for, and the
    // camera may have moved on since.
    const run = solution.run_id === null ? null : runById(solution.run_id);

    return {
        ok: true,
        review_id: review.id,
        review_token: review.token,
        round: review.round,
        max_rounds: cfg.maxRounds,
        assignment: {
            markdown: run?.assignment_markdown ?? "",
            version: solution.assignment_version,
            complete: run ? run.assignment_done === 1 : true,
        },
        solution: { id: solution.id, markdown: solution.markdown, model: solution.model },
        rubric: {
            problems: rubricFor(solution.markdown),
            note:
                `Bands are assigned by position: the first ${cfg.answerBand} problem(s) are ` +
                `answer-band. Change a problem's band ONLY if the paper itself marks the parts ` +
                `(ЧАСТЬ А / ЧАСТЬ В, «развёрнутое решение»); report the band you graded against.`,
        },
        previous: previousVerdict(review),
    };
}

/**
 * What the last round asked for.
 *
 * Only from round 2 on, and only ever one round back: the reviewer's job is to
 * check the paper in front of it, and handing it the whole grading history
 * invites it to defer to its predecessor instead of reading the working again.
 * One round is what it needs to answer the one question its predecessor left —
 * did the fix land.
 */
function previousVerdict(review: ReviewRow): ReviewClaim["previous"] {
    if (review.round <= 1) return null;
    const prior = reviewBefore(review.id);
    if (!prior || prior.total === null) return null;
    return {
        round: prior.round,
        total: prior.total,
        max_total: prior.max_total ?? 0,
        problems: parseProblems(prior),
    };
}

export function parseProblems(review: ReviewRow): ProblemVerdict[] {
    if (!review.problems) return [];
    try {
        const parsed = JSON.parse(review.problems);
        return Array.isArray(parsed) ? (parsed as ProblemVerdict[]) : [];
    } catch {
        return [];
    }
}

export interface SubmitReviewResult {
    ok: boolean;
    reason?: string;
    review_id?: number;
    total?: number;
    max_total?: number;
    /** Problem ids sent back for another attempt. */
    resolving?: string[];
    /** What happened next: a revision run, or why there wasn't one. */
    next?: string;
}

/**
 * The verdict. Same token discipline as a solve: only a live review's token is
 * accepted, so a grader whose subject has been replaced cannot land a score on
 * the solution that replaced it.
 */
export async function submitReview(
    token: string,
    raw: unknown,
): Promise<SubmitReviewResult> {
    const review = reviewByToken(token);
    if (!review) return { ok: false, reason: "unknown_or_superseded_token" };

    const solution = solutionById(review.solution_id);
    if (!solution) return { ok: false, reason: "solution_missing" };

    const verdict = gradeVerdict(raw, rubricFor(solution.markdown));
    if (typeof verdict === "string") return { ok: false, reason: verdict };

    finishReview(review.id, "done", {
        model: verdict.model,
        total: verdict.total,
        max_total: verdict.max_total,
        problems: verdict.problems,
        summary: verdict.summary,
    });
    console.log(
        `[review] review ${review.id} scored ${verdict.total}/${verdict.max_total}` +
            (verdict.failed.length ? ` — back: ${verdict.failed.join(", ")}` : " — all passed"),
    );
    notify();

    const next = await afterVerdict(review, solution, verdict);
    return {
        ok: true,
        review_id: review.id,
        total: verdict.total,
        max_total: verdict.max_total,
        resolving: verdict.failed,
        next,
    };
}

/**
 * What a verdict causes.
 *
 * Imported from solver.ts at call time rather than at module load: the two
 * modules genuinely need each other (a solve starts a review, a review starts a
 * solve) and the cycle is function-level only — exactly the arrangement
 * backup.ts already uses against solver.ts.
 */
async function afterVerdict(
    review: ReviewRow,
    solution: SolutionRow,
    verdict: Verdict,
): Promise<string> {
    if (verdict.failed.length === 0) return "every problem passed";

    if (review.round >= cfg.maxRounds) {
        // Stop, and say so plainly. The document keeps the score in its footer,
        // so a paper that could not be brought up to standard says which
        // problems are still short rather than looking finished.
        const why =
            `round ${review.round} of ${cfg.maxRounds} — not re-solving ` +
            `${verdict.failed.join(", ")}`;
        console.log(`[review] ${why}`);
        return why;
    }

    const { startRevisionRun } = await import("./solver");
    const result = await startRevisionRun({
        solution,
        round: review.round + 1,
        problems: verdict.problems.filter((p) => p.resolve),
    });
    return result.ok
        ? `round ${review.round + 1}: re-solving ${verdict.failed.join(", ")} (run ${result.run_id})`
        : `could not start a re-solve: ${result.detail ?? "unknown"}`;
}

export function failReview(token: string, error: string): { ok: boolean; reason?: string } {
    const review = reviewByToken(token);
    if (!review) return { ok: false, reason: "unknown_or_superseded_token" };
    finishReview(review.id, "failed", null, error.slice(0, 500) || "the reviewer reported a failure");
    console.warn(`[review] review ${review.id} failed: ${error}`);
    notify();
    return { ok: true };
}

// ── what the status feed and the document footer read ───────────────────────

export interface ReviewStatus {
    configured: boolean;
    detail: string;
    max_rounds: number;
    /** queued | grading | graded | failed | none — the live one, or the last. */
    state: "none" | "queued" | "grading" | "graded" | "failed";
    review: {
        id: number;
        solution_id: number;
        round: number;
        state: string;
        model: string | null;
        total: number | null;
        max_total: number | null;
        summary: string | null;
        error: string | null;
        created_at: number;
        age_ms: number;
        /** Problems still short after this verdict. */
        outstanding: string[];
    } | null;
}

export function getReviewStatus(): ReviewStatus {
    expireStaleReview();
    const review = activeReview() ?? latestReview();

    let state: ReviewStatus["state"] = "none";
    if (review) {
        if (review.state === "pending") state = "queued";
        else if (review.state === "claimed") state = "grading";
        else if (review.state === "done") state = "graded";
        else if (review.state === "failed") state = "failed";
    }

    return {
        configured: isEnabled(),
        detail: description(),
        max_rounds: cfg.maxRounds,
        state,
        review: review
            ? {
                  id: review.id,
                  solution_id: review.solution_id,
                  round: review.round,
                  state: review.state,
                  model: review.model,
                  total: review.total,
                  max_total: review.max_total,
                  summary: review.summary,
                  error: review.error,
                  created_at: review.created_at,
                  age_ms: Date.now() - review.created_at,
                  outstanding: parseProblems(review)
                      .filter((p) => p.resolve)
                      .map((p) => p.id),
              }
            : null,
    };
}

/**
 * How long a verdict's note may be under one problem.
 *
 * The panel fits roughly forty characters to a line at the document's size, so
 * this is two and a bit lines — enough to say what is missing, short enough that
 * the grader's remark never outweighs the working it is about. The full text is
 * in `/review/status` for anything that wants it.
 */
const NOTE_CHARS = 110;

/**
 * Hang each problem's mark under the problem itself.
 *
 * The footer's total says whether to trust the paper; this says *which question*
 * to look at again, which is the thing you actually act on. It goes directly
 * after the answer line because that is where the eye already is when it stops.
 *
 * Only ever the verdict on THIS solution — a later re-solve is a different row
 * with its own review, so a corrected problem shows its new mark rather than the
 * complaint that got it corrected.
 */
export function withRatings(markdown: string, solutionId: number): string {
    const review = latestReviewFor(solutionId);
    if (!review) return markdown;

    const byId = new Map(
        parseProblems(review).map((p) => [p.id.trim().toLowerCase(), p]),
    );
    if (byId.size === 0) return markdown;

    return annotateSections(markdown, (key) => {
        if (key === null) return null;
        const v = byId.get(key.trim().toLowerCase());
        if (!v) return null;

        const score = `${v.points}/${v.max}`;
        const note = (v.resolve ? v.fix || v.notes : v.notes).trim();
        if (!note) return `*Rated ${score}*`;
        const short =
            note.length > NOTE_CHARS ? `${note.slice(0, NOTE_CHARS - 1).trimEnd()}…` : note;
        return `*Rated ${score} — ${short}*`;
    });
}

/**
 * The score line for a solution's footer, or null when it hasn't been graded.
 *
 * On the page rather than only in the status feed, for the reason withByline
 * already gives: the glasses app ships separately from this server and the two
 * drift for weeks, so anything that has to be SEEN belongs in the markdown.
 * A number you can read at arm's length is also the only form of this a person
 * actually uses — 63/66 says "trust it", 48/66 says "check problem 4 yourself".
 */
export function scoreLine(solutionId: number): string | null {
    const review = latestReviewFor(solutionId);
    if (!review || review.total === null) return null;

    const outstanding = parseProblems(review)
        .filter((p) => p.resolve)
        .map((p) => p.id);
    const score = `${review.total}/${review.max_total ?? 0}`;
    const who = review.model?.trim();
    const by = who ? ` by ${who}` : "";
    return outstanding.length
        ? `Reviewed${by}: ${score} — still short on ${outstanding.join(", ")}`
        : `Reviewed${by}: ${score}`;
}

export type { ReviewRow };
