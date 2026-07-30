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

import { hashContent, type DocSource, type Snapshot } from "./doc";
import {
  activeRun,
  cancelActiveRun,
  claimNextRun,
  createRun,
  finishRun,
  insertSolution,
  latestRun,
  latestSolution,
  latestSolutionFor,
  recentSolutions,
  recordTrigger,
  runByToken,
  solutionCount,
  solutionById,
  type RunRow,
  type SolutionRow,
} from "./db";
import {
  assignmentSource,
  getStatus as getAssignmentStatus,
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
    version: number | null;
    /** From the reader: how much of the page it believes it has. */
    problems: number;
    done: boolean;
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
  } | null;
  /** Whether a tap starts the routine now or only queues it. */
  trigger: { configured: boolean; detail: string };
  /**
   * The server's own solver, which takes a run no agent claimed (see backup.ts).
   * With this configured, `queued` is a stage rather than a dead end.
   */
  backup: { configured: boolean; detail: string };
  /** How many solutions are on disk, so the count survives a restart visibly. */
  solutions: number;
  /**
   * The version picker's list, newest first. `version` counts from the first
   * solution ever submitted, so the number a footer shows is the same number
   * tomorrow — an index into this array would shift under every new solve.
   */
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
}> {
  const s = getAssignmentStatus();
  if (!assignmentConfigured()) return { snapshot: null, problems: 0, done: false };
  try {
    const snapshot = await assignmentSource.read();
    // A reader with nothing transcribed still answers with a title-only stub;
    // treat "no problems yet" as nothing to solve.
    //
    // `done` alone is not "we have the whole paper": every problem the reader
    // holds can be complete while the bottom of the sheet was never in frame.
    // The reader gates its own `done` on that now, so this only differs for a
    // scan finished under the old rule — and there, telling the solver the
    // transcription may be partial is exactly right. It solves what is there
    // and notes the gap.
    return { snapshot, problems: s.problems, done: s.done && s.full_page_seen };
  } catch (err) {
    console.error("[solver] assignment read failed:", err);
    return { snapshot: null, problems: s.problems, done: s.done };
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

  const { snapshot, problems, done } = await readAssignment();
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
    assignment: { available: Boolean(snapshot), version, problems, done },
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
        }
      : null,
    trigger: { configured: triggerConfigured(), detail: triggerDescription() },
    backup: { configured: backupConfigured(), detail: backupDescription() },
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
  if (!who) return solution.markdown;
  // A rule then one italic line: enough to read as a footer and not as the last
  // step of the working, at the cost of one row on the final page.
  return `${solution.markdown.replace(/\s+$/, "")}\n\n---\n\n*Solved by ${who}*\n`;
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
  const { snapshot, problems, done } = await readAssignment();
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
      `transcription ${done ? "complete" : "incomplete"}. Claim it.`,
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

/** Give up on the live run. Its token dies with it. */
export function cancelRun(): SolveResult {
  const run = cancelActiveRun();
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
  assignment?: {
    markdown: string;
    version: number | null;
    problems: number;
    /** False when the reader hadn't finished reading the page — solve what's there. */
    complete: boolean;
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
  console.log(`[solver] run ${run.id} claimed`);
  return {
    ok: true,
    run_id: run.id,
    run_token: run.token,
    assignment: {
      markdown: run.assignment_markdown ?? "",
      version: run.assignment_version,
      problems: run.assignment_problems,
      complete: run.assignment_done === 1,
    },
  };
}

export interface SubmitResult {
  ok: boolean;
  reason?: string;
  solution_id?: number;
  version?: number;
}

/**
 * The answer. Rejected unless the token still belongs to a live run — which is
 * how a superseded agent's late submission is kept out of the display.
 */
export function submitSolution(
  token: string,
  markdown: string,
  model?: string | null,
  notes?: string | null,
): SubmitResult {
  const run = runByToken(token);
  if (!run) return { ok: false, reason: "unknown_or_superseded_token" };

  const text = markdown.trim();
  if (!text) return { ok: false, reason: "empty_markdown" };
  if (text.length > MAX_MARKDOWN_CHARS) {
    return { ok: false, reason: `markdown_too_long_${text.length}` };
  }

  const solution = insertSolution({
    run_id: run.id,
    assignment_version: run.assignment_version,
    markdown: text,
    model: model ?? null,
    notes: notes ?? null,
  });
  finishRun(run.id, "done");
  console.log(
    `[solver] run ${run.id} solved: ${text.length} chars (solution ${solution.id})`,
  );

  // Document first: the glasses should be fetching tiles by the time the status
  // event tells them the run is over.
  notifyDocument();
  notifyStatus();
  return { ok: true, solution_id: solution.id, version: hashContent(text) };
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
