// The solve loop: what the AI page's trigger button actually does.
//
//   tap on the glasses ──▶ POST /solution/solve
//                            mints a run + a one-time token, then kicks the
//                            Claude routine (server/trigger.ts)
//
//   the routine ──▶ GET /solution/claim      the assignment text + that token
//               ──▶ POST /solution/submit    the finished markdown
//
// The token is the whole concurrency story. It is minted per run and every
// earlier run is superseded in the same transaction (see db.ts), so if you tap
// again — because the first attempt is slow, or the camera has moved on — the
// older agent's token is dead and its answer is rejected on arrival. Exactly
// one answer can ever land for the request you made last, and it is impossible
// for a stale agent to overwrite a fresh solution.
//
// The routine is told to solve the assignment *as it stood when you tapped*:
// the markdown is snapshotted into the run row rather than refetched at claim
// time, because the paper under the camera can change between the two.
//
// This module also owns the AI page's document: the newest submitted solution,
// falling back to the repo's solution.md when nothing has been solved yet. So
// the page works exactly as before on a fresh deployment, and the button is
// what fills it in.
//
// AND IT IS NOW HALF A LOOP. An answer that lands is handed to a second agent
// to grade (review.ts), and the problems that fall short come back here as a
// REVISION RUN: the same queue, the same one-time tokens, the same routine —
// but scoped to those problems and carrying what the reviewer said about each.
// A revision submits only the sections it redid and they are spliced into the
// solution it is correcting, so problems that already passed are preserved
// exactly rather than re-generated and re-checked.

import { hashContent, type DocSource, type Snapshot } from "./doc";
import {
  activeRun,
  cancelActiveRun,
  claimNextRun,
  createRun,
  finishRun,
  getSetting,
  insertSolution,
  latestRun,
  latestSolution,
  latestSolutionFor,
  recentSolutions,
  recordTrigger,
  runById,
  runByToken,
  solutionCount,
  solutionById,
  type RunRow,
  type SolutionRow,
} from "./db";
import { sectionKeys, spliceSections } from "./sections";
import {
  cancelReviews,
  getReviewStatus,
  isEnabled as reviewEnabled,
  scoreLine,
  startReview,
  subscribeReview,
  withRatings,
  type ProblemVerdict,
  type ReviewStatus,
} from "./review";
import {
  activeAssignment,
  assignmentSource,
  isConfigured as assignmentConfigured,
} from "./assignment";
import { isConfigured as triggerConfigured, runRoutine, triggerDescription } from "./trigger";
import {
  description as backupDescription,
  isConfigured as backupConfigured,
} from "./backup";

/** A claimed run that never submits would otherwise show "solving" forever. */
const CLAIMED_TIMEOUT_MS = Number(process.env.SOLVE_TIMEOUT_MS ?? 20 * 60_000);
/** A queued run waiting for the routine's cron. Generous: the cron is hourly. */
const QUEUED_TIMEOUT_MS = Number(process.env.SOLVE_QUEUE_TIMEOUT_MS ?? 3 * 3600_000);
/** Refuse absurd submissions rather than trying to render them into tiles. */
const MAX_MARKDOWN_CHARS = Number(process.env.SOLVE_MAX_CHARS ?? 200_000);

/** The static secret the routine claims with. Empty disables the check. */
const SOLVER_TOKEN = process.env.SOLVER_TOKEN ?? "";

// ── status ──────────────────────────────────────────────────────────────────

export interface SolverStatus {
  /**
   * What the glasses draw:
   *   no_assignment  nothing to solve (no reader, or nothing transcribed yet)
   *   idle           solvable, and no solution for this assignment → BUTTON
   *   queued         run created, waiting for the routine to pick it up
   *   solving        the agent has claimed it and is working
   *   solved         the displayed solution belongs to this assignment
   *   failed         the last attempt failed → button, with the reason
   */
  state: "no_assignment" | "idle" | "queued" | "solving" | "solved" | "failed";
  assignment: {
    available: boolean;
    /**
     * A CONTENT HASH of the markdown being solved, not the reader's attempt
     * number — the two are different numbering systems and only this one decides
     * whether a solution still answers what is on screen.
     */
    version: number | null;
    /** From the reader: how much of the page it believes it has. */
    problems: number;
    done: boolean;
    /**
     * The reader attempt number the button is pointed at, null while it follows
     * the live scan. This IS the picker's numbering — it is what the glasses
     * label a scan with, and the one number a person can act on.
     */
    active_version: number | null;
  };
  solution: {
    created_at: number;
    age_ms: number;
    model: string | null;
    assignment_version: number | null;
    /** True when what's displayed solves an *earlier* scan than the current one. */
    stale: boolean;
    chars: number;
  } | null;
  run: {
    id: number;
    state: string;
    created_at: number;
    age_ms: number;
    claimed: boolean;
    /** triggered | unconfigured | failed — how the routine was (not) kicked. */
    trigger: string | null;
    trigger_detail: string | null;
    error: string | null;
    /** 1 on a first attempt; 2+ while the reviewer's corrections are being made. */
    round: number;
    /** The problems this run is re-solving, empty on a first attempt. */
    revising: string[];
  } | null;
  /** The grader: its rubric, and how the last (or live) verdict went. */
  review: ReviewStatus;
  /** Whether a tap starts the routine now or only queues it. */
  trigger: { configured: boolean; detail: string };
  /**
   * The server's own solver, which takes a run no agent claimed (see backup.ts).
   * With this configured, `queued` is a stage rather than a dead end.
   */
  backup: { configured: boolean; detail: string };
  /** online | offline | auto — what the glasses showed and the solver reads. */
  mode: "online" | "offline" | "auto";
  /** How many solutions are on disk, so the count survives a restart visibly. */
  solutions: number;
  /**
   * The version picker's list, newest first. `version` counts from the first
   * solution ever submitted, so the number a footer shows is the same number
   * tomorrow — an index into this array would shift under every new solve.
   */
  // NOTE ON `state` AND THE REVIEW LOOP. There is deliberately no `reviewing`
  // variant in the union above. The glasses app is packed and installed
  // separately from this server and the two drift for weeks, and its renderer
  // switches on this exact string with no default arm — a state it has never
  // heard of draws an empty panel. So grading shows up in `review` (which an
  // older client simply ignores) and, where it has to be *seen*, in the
  // document's own footer. A revision run in flight reads as `solving`, which
  // is both true and already handled everywhere.
  solution_history: Array<{
    id: number;
    version: number;
    created_at: number;
    model: string | null;
    assignment_version: number | null;
    chars: number;
  }>;
}

const statusListeners = new Set<() => void>();
const docListeners = new Set<() => void>();

/** The problem numbers a run is re-solving; empty on a first attempt. */
function revisionProblems(run: RunRow): string[] {
  if (!run.revision_problems) return [];
  try {
    const parsed = JSON.parse(run.revision_problems);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function subscribeSolver(fn: () => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

function notifyStatus(): void {
  for (const fn of statusListeners) fn();
}

function notifyDocument(): void {
  for (const fn of docListeners) fn();
}

/**
 * The assignment as the solver sees it. Its version is what decides whether the
 * button comes back: a new sheet of paper hashes differently, so the solution on
 * screen becomes `stale` and the page offers to solve the new one.
 */
async function readAssignment(): Promise<{
  snapshot: Snapshot | null;
  problems: number;
  done: boolean;
  /** The pinned scan this came from, or null when it came from the live one. */
  pinned: number | null;
}> {
  if (!assignmentConfigured()) {
    return { snapshot: null, problems: 0, done: false, pinned: null };
  }
  // Not necessarily the live scan: see setActiveVersion(). Everything below is
  // written against whichever one this resolves to, so a pinned run is built
  // exactly the way a live one is.
  const { source, pinned, problems, done } = activeAssignment();
  try {
    const snapshot = await source.read();
    // A reader with nothing transcribed still answers with a title-only stub;
    // treat "no problems yet" as nothing to solve.
    //
    // `done` alone is not "we have the whole paper": every problem the reader
    // holds can be complete while the bottom of the sheet was never shown to
    // the camera. The reader gates its own `done` on coverage — every edge of
    // the paper seen by SOME frame — so its answer is the whole answer, and
    // second-guessing it with `full_page_seen` would now be wrong: a sheet read
    // correctly in two halves never has a frame holding all of it, and the
    // solver would be told a finished transcription was partial forever.
    return { snapshot, problems, done, pinned };
  } catch (err) {
    console.error("[solver] assignment read failed:", err);
    return { snapshot: null, problems, done, pinned };
  }
}

/**
 * Time out runs nobody will ever finish. Called from the status path and from a
 * slow interval, so a stuck run resolves itself whether or not anyone is
 * watching the page.
 */
function expireStaleRun(): boolean {
  const run = activeRun();
  if (!run) return false;
  const age = Date.now() - (run.claimed_at ?? run.created_at);
  const limit = run.state === "claimed" ? CLAIMED_TIMEOUT_MS : QUEUED_TIMEOUT_MS;
  if (age < limit) return false;

  const what =
    run.state === "claimed"
      ? `the agent claimed this run ${Math.round(age / 60_000)}m ago and never submitted`
      : `no agent picked this run up in ${Math.round(age / 60_000)}m`;
  finishRun(run.id, "failed", `timed out: ${what}`);
  console.warn(`[solver] run ${run.id} timed out (${run.state})`);
  return true;
}

setInterval(() => {
  if (expireStaleRun()) notifyStatus();
}, 60_000).unref?.();

/** Cached so /solution/status and the SSE feed don't refetch on every hit. */
let lastAssignmentVersion: number | null = null;

export async function getSolverStatus(): Promise<SolverStatus> {
  expireStaleRun();

  const { snapshot, problems, done, pinned } = await readAssignment();
  // The hash of the pinned scan when there is one, so `solvedThis` and `stale`
  // below compare the solution against the sheet the button would actually send
  // — pinning changes what "already solved" means, and it has to.
  const version = snapshot?.version ?? null;
  lastAssignmentVersion = version;

  const solution = latestSolution();
  const run = activeRun() ?? latestRun();
  const solvedThis =
    version !== null && latestSolutionFor(version) !== null;

  const now = Date.now();
  const total = solutionCount();
  const history = recentSolutions();
  const active = run && (run.state === "pending" || run.state === "claimed");

  let state: SolverStatus["state"];
  if (active) state = run!.state === "claimed" ? "solving" : "queued";
  else if (solvedThis) state = "solved";
  else if (!snapshot || problems === 0) state = "no_assignment";
  // Only a real failure reports as one. Cancelling your own solve is a decision,
  // and reading it back as "SOLVE FAILED - no reason given" made the glasses
  // accuse the person who pressed the button.
  else if (run?.state === "failed") state = "failed";
  else state = "idle";

  return {
    state,
    assignment: {
      available: Boolean(snapshot),
      version,
      problems,
      done,
      active_version: pinned,
    },
    solution: solution
      ? {
          created_at: solution.created_at,
          age_ms: now - solution.created_at,
          model: solution.model,
          assignment_version: solution.assignment_version,
          stale: version !== null && solution.assignment_version !== version,
          chars: solution.markdown.length,
        }
      : null,
    run: run
      ? {
          id: run.id,
          state: run.state,
          created_at: run.created_at,
          age_ms: now - run.created_at,
          claimed: run.claimed_at !== null,
          trigger: run.trigger_state,
          trigger_detail: run.trigger_detail,
          error: run.error,
          round: run.round,
          revising: revisionProblems(run),
        }
      : null,
    review: getReviewStatus(),
    trigger: { configured: triggerConfigured(), detail: triggerDescription() },
    backup: { configured: backupConfigured(), detail: backupDescription() },
    mode: (getSetting("mode") as SolverStatus["mode"]) || "auto",
    solutions: total,
    // Newest first, so the newest carries the highest ordinal.
    solution_history: history.map((item, i) => ({
      id: item.id,
      version: total - i,
      created_at: item.created_at,
      model: item.model,
      assignment_version: item.assignment_version,
      chars: item.markdown.length,
    })),
  };
}

// A verdict landing changes what the AI page says about the solution on it, and
// the score it carries in its footer, so the grader's progress moves our status
// and our document exactly as the solver's own does.
subscribeReview(() => {
  notifyStatus();
  notifyDocument();
});

// A new scan means the displayed solution no longer answers what's on the paper,
// which changes what the button says — so the reader's changes move our status
// too, not just the assignment page's.
assignmentSource.subscribe(() => {
  void assignmentSource
    .read()
    .then(({ version }) => {
      if (version === lastAssignmentVersion) return;
      lastAssignmentVersion = version;
      notifyStatus();
    })
    .catch(() => {});
});

// ── the AI page's document ──────────────────────────────────────────────────

/**
 * The AI document: the newest submitted solution, or `fallback` (solution.md)
 * when nothing has been solved on this deployment yet.
 *
 * The newest solution is served even when it answers an earlier scan. Losing
 * sight of a solution because the camera drifted would be worse than showing one
 * the pager labels as belonging to a previous version — and the button is there
 * to solve the new one when you want it.
 */
/**
 * The line at the foot of a solution naming what produced it.
 *
 * There are now three things that can answer a tap — the cloud routine, the CLI
 * runner, and the server's own backup solver — and they are not equally good.
 * Whether the working you are checking came from an agent that could verify its
 * own arithmetic or from one model call changes how hard you look at it, so it
 * has to be on the page.
 *
 * On the page, specifically, rather than in the status feed: the glasses app is
 * packed and installed separately from this server and the two drift for weeks,
 * so anything that has to be *rendered* to be seen belongs in the markdown,
 * where it reaches the glasses the moment the server has it.
 */
function withByline(solution: SolutionRow): string {
  const who = solution.model?.trim();
  // Each problem's own mark, under the problem. The footer's total says whether
  // to trust the paper; the per-problem lines say which question to look at
  // again, and that is the one you act on.
  const body = withRatings(solution.markdown, solution.id);
  // The grader's verdict on THIS solution, when it has one. Same argument as the
  // byline's: a score is only useful if you can see it while you are reading the
  // working it grades, and it says what to do next — 63/66 means trust it, 48/66
  // with problem 4 named means check that one yourself.
  const score = scoreLine(solution.id);

  const lines = [who ? `Solved by ${who}` : null, score].filter(Boolean) as string[];
  if (lines.length === 0) return body;

  // A rule then italic lines: enough to read as a footer and not as the last
  // step of the working, at the cost of a row or two on the final page.
  const footer = lines.map((line) => `*${line}*`).join("\n\n");
  return `${body.replace(/\s+$/, "")}\n\n---\n\n${footer}\n`;
}

export function createAiSource(fallback: DocSource, selectedId?: number): DocSource {
  return {
    name: "ai",
    async read(): Promise<Snapshot> {
      const solution = selectedId === undefined ? latestSolution() : solutionById(selectedId);
      if (!solution) return fallback.read();
      // Hash the rendered text, byline included, rather than the row id: a
      // re-solve that produces identical text then costs no render and no BLE
      // push, and a solution attributed to a different model does.
      const content = withByline(solution);
      return { content, version: hashContent(content) };
    },
    subscribe(onChange: () => void): () => void {
      docListeners.add(onChange);
      const unsubscribeFallback = fallback.subscribe(onChange);
      return () => {
        docListeners.delete(onChange);
        unsubscribeFallback();
      };
    },
  };
}

// ── actions ─────────────────────────────────────────────────────────────────

export interface SolveResult {
  ok: boolean;
  /** `triggered` | `queued` | `cancelled` | `failed` — labels the glasses box. */
  action: "triggered" | "queued" | "cancelled" | "failed";
  detail?: string;
  run_id?: number;
}

/**
 * Create a run and kick the routine.
 *
 * An incomplete transcription is allowed on purpose: the reader often has every
 * problem readable well before it declares itself done, and only you can see the
 * paper. The glasses say the assignment is incomplete; the tap is still yours.
 */
export async function startRun(): Promise<SolveResult> {
  const { snapshot, problems, done, pinned } = await readAssignment();
  if (!snapshot) {
    return {
      ok: false,
      action: "failed",
      detail: assignmentConfigured()
        ? "the reader is unreachable"
        : "no assignment reader configured",
    };
  }
  if (problems === 0) {
    return { ok: false, action: "failed", detail: "nothing transcribed yet" };
  }

  // A grading in flight is about a solution you have just decided to replace.
  // Left running, its verdict would arrive minutes later and start a revision of
  // a document nobody is looking at any more — and that revision would land on
  // the solve queue in front of this one.
  cancelReviews("a new solve was requested");

  const run = createRun({
    token: crypto.randomUUID(),
    assignment_version: snapshot.version,
    assignment_markdown: snapshot.content,
    assignment_done: done,
    assignment_problems: problems,
  });
  notifyStatus();

  // Context for the fire payload. It arrives at the session labelled untrusted
  // (by design), so it says only which run is waiting and how big it is — the
  // work itself comes from /solution/claim.
  const trigger = await runRoutine(
    `A solve was requested from the glasses: run ${run.id}, ` +
      `${problems} problem${problems === 1 ? "" : "s"}, ` +
      `transcription ${done ? "complete" : "incomplete"}` +
      // Only worth saying when it isn't the obvious one — a session reading this
      // has no other way to know it is answering a sheet from an hour ago.
      (pinned === null ? "" : `, from archived scan v${pinned}`) +
      `. Claim it.`,
  );
  recordTrigger(run.id, trigger.state, trigger.detail);
  notifyStatus();

  if (trigger.state === "triggered") {
    console.log(`[solver] run ${run.id} triggered (${trigger.detail})`);
    return { ok: true, action: "triggered", run_id: run.id };
  }

  // Not an error: the run is on the queue and the routine's cron will find it.
  // Say which it was, so a misconfigured trigger is visible rather than silent.
  console.log(
    `[solver] run ${run.id} queued — trigger ${trigger.state}: ${trigger.detail}`,
  );
  return {
    ok: true,
    action: "queued",
    run_id: run.id,
    detail: trigger.detail ?? undefined,
  };
}

export interface RevisionRequest {
  /** The solution being corrected. Its text is the base the answer splices into. */
  solution: SolutionRow;
  round: number;
  /** The reviewer's verdicts for the problems that failed. */
  problems: ProblemVerdict[];
}

/**
 * Send the failed problems back for another attempt.
 *
 * Called by review.ts when a verdict falls short. It goes through the ORDINARY
 * solve queue on purpose — createRun, the same one-time token, the same routine
 * — so a revision inherits the whole concurrency story unchanged: tap solve
 * while it is working and its token dies, exactly like any other run. There is
 * no second way for an answer to reach the display.
 *
 * The paper it carries is the one the original run was given, not a fresh read.
 * A correction has to be graded against the same sheet as the thing it corrects,
 * or the second round is answering a different question from the first.
 */
export async function startRevisionRun(req: RevisionRequest): Promise<SolveResult> {
  const source = req.solution.run_id === null ? null : runById(req.solution.run_id);
  const markdown = source?.assignment_markdown ?? "";
  if (!markdown) {
    return {
      ok: false,
      action: "failed",
      detail: `solution ${req.solution.id} has no stored assignment to re-solve against`,
    };
  }
  if (req.problems.length === 0) {
    return { ok: false, action: "failed", detail: "no problems to revise" };
  }

  const problems = req.problems.map((p) => p.id);
  const run = createRun({
    token: crypto.randomUUID(),
    assignment_version: source!.assignment_version,
    assignment_markdown: markdown,
    assignment_done: source!.assignment_done === 1,
    assignment_problems: source!.assignment_problems,
    revision: {
      of: req.solution.id,
      problems,
      notes: req.problems.map((p) => ({
        id: p.id,
        band: p.band,
        points: p.points,
        max: p.max,
        answer_correct: p.answer_correct,
        notes: p.notes,
        fix: p.fix,
      })),
    },
    round: req.round,
  });
  notifyStatus();

  const trigger = await runRoutine(
    `A review sent work back: run ${run.id}, round ${req.round}, ` +
      `re-solve problem${problems.length === 1 ? "" : "s"} ${problems.join(", ")} ` +
      `of solution ${req.solution.id}. Claim it.`,
  );
  recordTrigger(run.id, trigger.state, trigger.detail);
  notifyStatus();

  console.log(
    `[solver] revision run ${run.id} (round ${req.round}, problems ${problems.join(", ")}) ` +
      `— trigger ${trigger.state}`,
  );
  return trigger.state === "triggered"
    ? { ok: true, action: "triggered", run_id: run.id }
    : { ok: true, action: "queued", run_id: run.id, detail: trigger.detail ?? undefined };
}

/**
 * Grade the solution currently on the AI page, on request.
 *
 * The automatic path starts a review the moment an answer lands; this covers
 * what that path cannot reach — a solution submitted while the reviewer was
 * unconfigured, or one you simply want looked at again.
 */
export async function reviewLatest(): Promise<{
  ok: boolean;
  detail?: string;
  review_id?: number;
}> {
  const solution = latestSolution();
  if (!solution) return { ok: false, detail: "nothing has been solved yet" };
  const run = solution.run_id === null ? null : runById(solution.run_id);
  const started = await startReview(solution, run);
  return started.ok
    ? { ok: true, review_id: started.review_id, detail: started.detail }
    : { ok: false, detail: started.detail ?? "the reviewer is not configured" };
}

/** Give up on the live run. Its token dies with it. */
export function cancelRun(): SolveResult {
  const run = cancelActiveRun();
  cancelReviews("the solve was cancelled");
  notifyStatus();
  if (!run) return { ok: false, action: "failed", detail: "nothing running" };
  return { ok: true, action: "cancelled", run_id: run.id };
}

export interface ClaimResult {
  ok: boolean;
  reason?: string;
  run_id?: number;
  /** The credential to submit with. Dies if a newer run is created. */
  run_token?: string;
  /** 1 on a first attempt; 2+ when the reviewer sent work back. */
  round?: number;
  assignment?: {
    markdown: string;
    version: number | null;
    problems: number;
    /** False when the reader hadn't finished reading the page — solve what's there. */
    complete: boolean;
  };
  /**
   * Present only on a revision run, and when it is present it changes the job
   * completely: solve these problems again, submit `sections` rather than a
   * whole document, and everything else in the solution is left alone.
   */
  revision?: {
    /** The solution being corrected. */
    solution_id: number;
    /** Its full text, so the agent can see what it is replacing and what stays. */
    solution_markdown: string;
    /** The problem numbers to redo, as the solution's own headings number them. */
    problems: string[];
    /** Every heading in that document, so a mismatch is visible before it submits. */
    all_problems: string[];
    /** The reviewer's verdict on each of `problems`. */
    notes: unknown;
  };
}

/**
 * What the routine calls first. Returns the token *and* the work in one round
 * trip, so there is no window in which the agent holds a token but doesn't yet
 * know what it is solving.
 */
export function claimRun(): ClaimResult {
  const run = claimNextRun();
  if (!run) return { ok: false, reason: "no_pending_run" };
  notifyStatus();

  const base = run.revision_of === null ? null : solutionById(run.revision_of);
  console.log(
    `[solver] run ${run.id} claimed` +
      (base ? ` (round ${run.round}, revising ${revisionProblems(run).join(", ")})` : ""),
  );

  return {
    ok: true,
    run_id: run.id,
    run_token: run.token,
    round: run.round,
    assignment: {
      markdown: run.assignment_markdown ?? "",
      version: run.assignment_version,
      problems: run.assignment_problems,
      complete: run.assignment_done === 1,
    },
    // A revision run whose base solution has somehow gone reads as an ordinary
    // solve rather than as a broken one: the paper is still there, so solving it
    // whole is a worse answer than the splice but a much better one than nothing.
    ...(base
      ? {
          revision: {
            solution_id: base.id,
            solution_markdown: base.markdown,
            problems: revisionProblems(run),
            all_problems: sectionKeys(base.markdown),
            notes: run.revision_notes ? safeParse(run.revision_notes) : null,
          },
        }
      : {}),
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export interface SubmitResult {
  ok: boolean;
  reason?: string;
  solution_id?: number;
  version?: number;
  /** Which problems a spliced revision replaced. */
  replaced?: string[];
  /** Problems the revision added, having found no section to replace. */
  added?: string[];
  /** What this run was actually asked to revise, when a key was outside it. */
  revising?: string[];
  /** The document's problem numbers, so a rejected key can be corrected. */
  known_problems?: string[];
  /** What was done with the answer next: a review, or why there wasn't one. */
  review?: string;
}

export interface Submission {
  /**
   * The whole document. The only form a first-pass solve may take, and still
   * accepted from a revision — the backup solver writes whole documents.
   */
  markdown?: string;
  /**
   * A revision's corrected problems, keyed by problem number. Spliced into the
   * solution being corrected (see sections.ts) so everything that passed is
   * preserved byte for byte rather than regenerated.
   */
  sections?: Record<string, string>;
  model?: string | null;
  notes?: string | null;
}

/**
 * The answer. Rejected unless the token still belongs to a live run — which is
 * how a superseded agent's late submission is kept out of the display.
 */
export function submitSolution(token: string, submission: Submission): SubmitResult {
  const run = runByToken(token);
  if (!run) return { ok: false, reason: "unknown_or_superseded_token" };

  const built = buildMarkdown(run, submission);
  if (!built.ok) return built.error;

  const text = built.markdown.trim();
  if (!text) return { ok: false, reason: "empty_markdown" };
  if (text.length > MAX_MARKDOWN_CHARS) {
    return { ok: false, reason: `markdown_too_long_${text.length}` };
  }

  const solution = insertSolution({
    run_id: run.id,
    assignment_version: run.assignment_version,
    markdown: text,
    model: submission.model ?? null,
    notes: submission.notes ?? null,
  });
  finishRun(run.id, "done");
  console.log(
    `[solver] run ${run.id} solved: ${text.length} chars (solution ${solution.id})` +
      (built.replaced?.length ? `, replaced ${built.replaced.join(", ")}` : "") +
      (built.added?.length ? `, added ${built.added.join(", ")}` : ""),
  );

  // Document first: the glasses should be fetching tiles by the time the status
  // event tells them the run is over.
  notifyDocument();
  notifyStatus();

  // Grading is started but NOT waited for. The answer is already on the glasses
  // and the agent that wrote it is holding this response open; a reviewer that
  // is slow, misconfigured or absent must not turn a good solve into a failed
  // submit. startReview never throws, and the catch is belt-and-braces.
  const reviewing = reviewEnabled();
  if (reviewing) {
    void startReview(solution, run).catch((err) =>
      console.error("[solver] could not start a review:", err),
    );
  }

  return {
    ok: true,
    solution_id: solution.id,
    version: hashContent(text),
    ...(built.replaced?.length ? { replaced: built.replaced } : {}),
    ...(built.added?.length ? { added: built.added } : {}),
    review: reviewing ? "queued for review" : "not reviewed",
  };
}

/**
 * The document this submission produces.
 *
 * Two shapes, and which one is allowed depends on the run: `sections` needs a
 * base solution to splice into, so it is meaningless on a first-pass run and is
 * refused there rather than silently treated as a document. A key that matches
 * no heading is refused too, with the document's real numbering in the reply —
 * dropping it quietly would leave a wrong answer on the glasses under a review
 * that believes it was corrected.
 */
type BuildResult =
  | { ok: true; markdown: string; replaced?: string[]; added?: string[] }
  | { ok: false; error: SubmitResult };

function buildMarkdown(run: RunRow, submission: Submission): BuildResult {
  const sections = submission.sections;
  if (!sections || Object.keys(sections).length === 0) {
    return { ok: true, markdown: submission.markdown ?? "" };
  }

  const base = run.revision_of === null ? null : solutionById(run.revision_of);
  if (!base) {
    return {
      ok: false,
      error: {
        ok: false,
        reason: "sections_need_a_revision_run — submit the whole document as `markdown`",
      },
    };
  }

  // Scoped to what the reviewer actually sent back. A revision is not a chance
  // to rewrite the paper: everything outside this list has been graded and
  // passed, and letting it be replaced would put unreviewed text on the glasses
  // under a score that was never about it.
  const allowed = revisionProblems(run);
  const spliced = spliceSections(base.markdown, sections, { allowed });
  if (!spliced.ok || !spliced.markdown) {
    return {
      ok: false,
      error: {
        ok: false,
        reason: `not_up_for_revision_${(spliced.unexpected ?? []).join("_") || "keys"}`,
        revising: allowed,
        known_problems: sectionKeys(base.markdown),
      },
    };
  }
  return {
    ok: true,
    markdown: spliced.markdown,
    replaced: spliced.replaced,
    added: spliced.added,
  };
}

// Your own answer is NOT here. It used to be — an extra row in `solutions` with
// source='me' — and that put it on the AI page, because that page shows the
// newest row whatever wrote it. Writing down your own working would then hide
// Claude's, which is not what either of them is for. It is a document now
// (slug my-solution, see docs.ts), read on the glasses' own Mine page.

/** The agent giving up. Keeps the reason for the glasses instead of a timeout. */
export function failRun(token: string, error: string): SubmitResult {
  const run = runByToken(token);
  if (!run) return { ok: false, reason: "unknown_or_superseded_token" };
  finishRun(run.id, "failed", error.slice(0, 500) || "the agent reported a failure");
  console.warn(`[solver] run ${run.id} failed: ${error}`);
  notifyStatus();
  return { ok: true };
}

/** Gate on the shared secret from .env; empty SOLVER_TOKEN means no gate. */
export function authorizeSolver(header: string | undefined): boolean {
  if (!SOLVER_TOKEN) return true;
  return header === SOLVER_TOKEN;
}

export function solverTokenRequired(): boolean {
  return SOLVER_TOKEN !== "";
}

export type { RunRow, SolutionRow };
