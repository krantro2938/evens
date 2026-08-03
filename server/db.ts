// Persistence for the solve loop: which runs were triggered, and what came
// back. SQLite rather than a file because three things must survive a restart
// and must not be lost by a half-written overwrite:
//
//   runs       one row per "solve this assignment" request, each with the
//              one-time token the agent submits its answer with
//   solutions  every markdown that ever came back, keyed to the assignment
//              version it was solving
//   reviews    one row per "grade that solution" request — the same shape as a
//              run, for the same reason, and deliberately NOT the same table
//              (see the note above the reviews CREATE)
//
// Nothing is ever deleted. A re-solve adds a row; the newest one wins. That
// means a bad solve never destroys the good one you had, and a solution stays
// readable on the glasses after the paper (and so the assignment) has changed.
//
// bun:sqlite is built into the runtime — no dependency, no native build step.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Defaults to ../data — /app/data in the container, which is a volume. */
export const DATA_DIR = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : resolve(__dirname, "..", "data");

const DB_PATH = process.env.SOLVER_DB ?? resolve(DATA_DIR, "solver.sqlite");

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH, { create: true });

// WAL so a long SELECT (the agent claiming a run) can't block the write that
// records a submitted solution.
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    -- The agent's one-time credential for submitting an answer. A new run mints
    -- a new one and supersedes the old, so a re-trigger silently invalidates
    -- whatever the previous agent was about to POST.
    token                TEXT    NOT NULL UNIQUE,
    state                TEXT    NOT NULL,
    -- The assignment as it stood when the run was created. Stored, not
    -- refetched: the agent must solve the paper you were looking at when you
    -- tapped, even if the camera has since moved on.
    assignment_version   INTEGER,
    assignment_markdown  TEXT,
    assignment_done      INTEGER NOT NULL DEFAULT 0,
    assignment_problems  INTEGER NOT NULL DEFAULT 0,
    -- Whether the routine was actually kicked, and what the API said if not.
    trigger_state        TEXT,
    trigger_detail       TEXT,
    -- A REVISION RUN: not "solve this paper" but "solve these problems again,
    -- the reviewer says they are wrong". The three columns are one unit —
    -- which solution is being corrected, which of its problems, and what the
    -- reviewer said about each. NULL on an ordinary first-pass run.
    --
    -- No REFERENCES: ALTER TABLE ADD COLUMN cannot add a foreign key, so a
    -- database migrated into this shape could not have one — and a constraint
    -- that exists only on installations created after today is worse than no
    -- constraint at all. Nothing deletes a solution, so there is nothing for it
    -- to catch.
    revision_of          INTEGER,
    revision_problems    TEXT,
    revision_notes       TEXT,
    -- 1 for a first attempt, 2 for the first revision, and so on. What bounds
    -- the solve/review loop — see REVIEW_MAX_ROUNDS in review.ts.
    round                INTEGER NOT NULL DEFAULT 1,
    created_at           INTEGER NOT NULL,
    claimed_at           INTEGER,
    finished_at          INTEGER,
    error                TEXT
  );

  CREATE TABLE IF NOT EXISTS solutions (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id               INTEGER REFERENCES runs(id),
    assignment_version   INTEGER,
    markdown             TEXT    NOT NULL,
    model                TEXT,
    notes                TEXT,
    -- Who wrote it. Every new row is 'agent': answers you write yourself are a
    -- document now (docs.my-solution), not an entry in this log. Rows from
    -- before that are 'me' and the column keeps them honest — see the note at
    -- the migration below.
    source               TEXT    NOT NULL DEFAULT 'agent',
    created_at           INTEGER NOT NULL
  );

  -- One grading pass over one solution, by the reviewer routine.
  --
  -- A SEPARATE TABLE FROM runs, not a "kind" column on it, and the reason is
  -- the concurrency story rather than tidiness. Runs have exactly one live
  -- token at a time: createRun supersedes every active row so a late answer
  -- from a superseded agent cannot land. A review is a different subject —
  -- it answers about a SOLUTION, not about the paper — and claimNextRun hands
  -- out the oldest pending row regardless of what it is for, so sharing the
  -- table would let the solve routine claim a review and the reviewer claim a
  -- solve. Two tables, two queues, two independent supersede rules; the solve
  -- loop's invariants are untouched by any of this.
  CREATE TABLE IF NOT EXISTS reviews (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    solution_id   INTEGER NOT NULL REFERENCES solutions(id),
    -- The solve run that produced that solution, for tracing one paper's whole
    -- solve -> review -> re-solve chain back through the log.
    run_id        INTEGER REFERENCES runs(id),
    token         TEXT    NOT NULL UNIQUE,
    state         TEXT    NOT NULL,
    round         INTEGER NOT NULL DEFAULT 1,
    model         TEXT,
    -- Points scored and points available across every problem graded. NULL
    -- until the reviewer submits.
    total         INTEGER,
    max_total     INTEGER,
    -- The per-problem verdicts, as the JSON the reviewer posted. Stored whole
    -- rather than exploded into a table: nothing queries inside it, and a
    -- shape that grows a field shouldn't need a migration to keep a record.
    problems      TEXT,
    summary       TEXT,
    trigger_state TEXT,
    trigger_detail TEXT,
    created_at    INTEGER NOT NULL,
    claimed_at    INTEGER,
    finished_at   INTEGER,
    error         TEXT
  );

  -- Documents you write by hand, one row per slug. See the note at putDoc for
  -- why this is a separate table from solutions rather than a flag on it.
  CREATE TABLE IF NOT EXISTS docs (
    slug        TEXT PRIMARY KEY,
    markdown    TEXT    NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  -- Short messages between the camera web app and the glasses. An append-only
  -- log in both directions: 'out' is typed on cam.aansl.com, 'in' is a quick
  -- reply tapped on the glasses.
  --
  -- Persisted rather than fanned out and forgotten because the glasses are
  -- offline most of the time. A message sent to a phone that is asleep has to
  -- be waiting when the app next connects, or the widget is a toy that only
  -- works when you happen to be wearing them.
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    body       TEXT    NOT NULL,
    -- 'out' = website -> glasses, 'in' = a reply tapped on the glasses.
    direction  TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    -- When the glasses actually put it on the screen. NULL = never shown, which
    -- is what makes the dashboard's unread count and the banner-on-connect
    -- behaviour possible. Only meaningful for 'out'.
    seen_at    INTEGER
  );

  -- Settings a device must not be trusted to remember. See the note at
  -- getSetting: the WebView does not keep localStorage across launches, so the
  -- one setting there is (the gallery bridge) has to live off the device.
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS runs_state_idx      ON runs(state);
  CREATE INDEX IF NOT EXISTS solutions_recent_idx ON solutions(created_at DESC);
  CREATE INDEX IF NOT EXISTS messages_recent_idx  ON messages(created_at DESC);
  CREATE INDEX IF NOT EXISTS reviews_state_idx    ON reviews(state);
  CREATE INDEX IF NOT EXISTS reviews_solution_idx ON reviews(solution_id);
`);

/**
 * `source` on a database that predates it.
 *
 * There is no migration framework here and this is the first column ever added,
 * so it is done inline: the CREATE above covers a fresh database, this covers
 * the one already sitting in data/. ADD COLUMN with a DEFAULT is the one shape
 * SQLite rewrites nothing for, and every existing row is genuinely an agent's.
 *
 * It is a column rather than a convention on `model` because the distinction is
 * not cosmetic: `model` is free text from whatever solved the paper, and
 * something that answers "did I write this?" cannot be a string nobody
 * validates. Nothing writes 'me' any more, but the AI page still shows the
 * newest row whatever wrote it, so the handful of rows you typed before the
 * split have to stay distinguishable from the agent's.
 */
function columns(table: string): Set<string> {
  return new Set(
    db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((c) => c.name),
  );
}

/**
 * Columns on a database that predates them.
 *
 * There is no migration framework here, so this is done inline: the CREATEs
 * above cover a fresh database, these cover the one already sitting in data/.
 * ADD COLUMN with a constant DEFAULT is the one shape SQLite rewrites nothing
 * for, which is why every added column here is nullable or has one.
 *
 * `solutions.source` was the first, and it is a column rather than a convention
 * on `model` because the distinction is not cosmetic: `model` is free text from
 * whatever solved the paper, and something that answers "did I write this?"
 * cannot be a string nobody validates. Nothing writes 'me' any more, but the AI
 * page still shows the newest row whatever wrote it, so the handful of rows you
 * typed before the split have to stay distinguishable from the agent's.
 *
 * The `runs` ones came with the review loop: an ordinary run leaves all four at
 * their defaults, so every row already in the table reads correctly as "a first
 * attempt at the whole paper", which is what it was.
 */
const MIGRATIONS: Array<[table: string, column: string, ddl: string]> = [
  ["solutions", "source", "ALTER TABLE solutions ADD COLUMN source TEXT NOT NULL DEFAULT 'agent'"],
  ["runs", "revision_of", "ALTER TABLE runs ADD COLUMN revision_of INTEGER"],
  ["runs", "revision_problems", "ALTER TABLE runs ADD COLUMN revision_problems TEXT"],
  ["runs", "revision_notes", "ALTER TABLE runs ADD COLUMN revision_notes TEXT"],
  ["runs", "round", "ALTER TABLE runs ADD COLUMN round INTEGER NOT NULL DEFAULT 1"],
];

for (const [table, column, ddl] of MIGRATIONS) {
  if (columns(table).has(column)) continue;
  db.exec(ddl);
  console.log(`[db] migrated: ${table}.${column}`);
}

/** A run's lifecycle. `superseded` is what a re-trigger does to its predecessor. */
export type RunState =
  | "pending" // created; the agent hasn't claimed it yet
  | "claimed" // the agent has the token and the assignment text
  | "done"
  | "failed"
  | "cancelled"
  | "superseded";

/** States in which a run's token is still worth something. */
const ACTIVE_STATES = "('pending','claimed')";

export interface RunRow {
  id: number;
  token: string;
  state: RunState;
  assignment_version: number | null;
  assignment_markdown: string | null;
  assignment_done: number;
  assignment_problems: number;
  trigger_state: string | null;
  trigger_detail: string | null;
  /** The solution being corrected, or null on a first attempt at the paper. */
  revision_of: number | null;
  /** JSON array of problem keys to redo, as the solution's headings number them. */
  revision_problems: string | null;
  /** JSON: what the reviewer said about each of those problems. */
  revision_notes: string | null;
  round: number;
  created_at: number;
  claimed_at: number | null;
  finished_at: number | null;
  error: string | null;
}

/** Who wrote a solution. Not a label — see the migration note above. */
export type SolutionSource = "agent" | "me";

export interface SolutionRow {
  id: number;
  run_id: number | null;
  assignment_version: number | null;
  markdown: string;
  model: string | null;
  notes: string | null;
  source: SolutionSource;
  created_at: number;
}

export interface NewRun {
  token: string;
  assignment_version: number | null;
  assignment_markdown: string | null;
  assignment_done: boolean;
  assignment_problems: number;
  /** Set together, or not at all — see the revision columns above. */
  revision?: {
    of: number;
    problems: string[];
    /** Free-form per-problem detail from the reviewer, serialised as-is. */
    notes: unknown;
  };
  round?: number;
}

// ── runs ────────────────────────────────────────────────────────────────────

/**
 * Supersede every active run and insert a fresh one, in a single transaction:
 * there is at most one live token at any instant, so the answer that lands is
 * always the answer to the request you made last.
 */
export const createRun = db.transaction((run: NewRun): RunRow => {
  const now = Date.now();
  db.query(
    `UPDATE runs SET state='superseded', finished_at=?1
      WHERE state IN ${ACTIVE_STATES}`,
  ).run(now);

  const row = db
    .query<RunRow, any[]>(
      `INSERT INTO runs (token, state, assignment_version, assignment_markdown,
                         assignment_done, assignment_problems,
                         revision_of, revision_problems, revision_notes, round,
                         created_at)
       VALUES (?1, 'pending', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       RETURNING *`,
    )
    .get(
      run.token,
      run.assignment_version,
      run.assignment_markdown,
      run.assignment_done ? 1 : 0,
      run.assignment_problems,
      run.revision?.of ?? null,
      run.revision ? JSON.stringify(run.revision.problems) : null,
      run.revision ? JSON.stringify(run.revision.notes ?? null) : null,
      Math.max(1, run.round ?? 1),
      now,
    );
  return row!;
});

export function recordTrigger(
  id: number,
  state: string,
  detail: string | null,
): void {
  db.query(`UPDATE runs SET trigger_state=?2, trigger_detail=?3 WHERE id=?1`).run(
    id,
    state,
    detail,
  );
}

/** The live run, if there is one. */
export function activeRun(): RunRow | null {
  return (
    db
      .query<RunRow, []>(
        `SELECT * FROM runs WHERE state IN ${ACTIVE_STATES}
          ORDER BY id DESC LIMIT 1`,
      )
      .get() ?? null
  );
}

export function latestRun(): RunRow | null {
  return (
    db.query<RunRow, []>(`SELECT * FROM runs ORDER BY id DESC LIMIT 1`).get() ??
    null
  );
}

export function runById(id: number): RunRow | null {
  return db.query<RunRow, [number]>(`SELECT * FROM runs WHERE id=?1`).get(id) ?? null;
}

/**
 * Hand the oldest unclaimed run to an agent. Atomic, so two agents racing on
 * the same queue can't both be told they own the same run.
 */
export const claimNextRun = db.transaction((): RunRow | null => {
  const row = db
    .query<RunRow, []>(
      `SELECT * FROM runs WHERE state='pending' ORDER BY id ASC LIMIT 1`,
    )
    .get();
  if (!row) return null;
  const now = Date.now();
  db.query(`UPDATE runs SET state='claimed', claimed_at=?2 WHERE id=?1`).run(
    row.id,
    now,
  );
  return { ...row, state: "claimed", claimed_at: now };
});

/** Look a run up by the token the agent presents. Only active tokens resolve. */
export function runByToken(token: string): RunRow | null {
  return (
    db
      .query<RunRow, [string]>(
        `SELECT * FROM runs WHERE token=?1 AND state IN ${ACTIVE_STATES}`,
      )
      .get(token) ?? null
  );
}

export function finishRun(
  id: number,
  state: Extract<RunState, "done" | "failed" | "cancelled">,
  error: string | null = null,
): void {
  db.query(
    `UPDATE runs SET state=?2, error=?3, finished_at=?4 WHERE id=?1`,
  ).run(id, state, error, Date.now());
}

/** Cancel whatever is live. Returns the run that was cancelled, if any. */
export const cancelActiveRun = db.transaction((): RunRow | null => {
  const row = activeRun();
  if (!row) return null;
  finishRun(row.id, "cancelled");
  return { ...row, state: "cancelled" };
});

// ── solutions ───────────────────────────────────────────────────────────────

export interface NewSolution {
  run_id: number | null;
  assignment_version: number | null;
  markdown: string;
  model: string | null;
  notes: string | null;
  source?: SolutionSource;
}

export function insertSolution(solution: NewSolution): SolutionRow {
  return db
    .query<SolutionRow, any[]>(
      `INSERT INTO solutions (run_id, assignment_version, markdown, model, notes, source, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       RETURNING *`,
    )
    .get(
      solution.run_id,
      solution.assignment_version,
      solution.markdown,
      solution.model,
      solution.notes,
      solution.source ?? "agent",
      Date.now(),
    )!;
}

/** The one the AI page shows: newest first, whatever it was solving. */
export function latestSolution(): SolutionRow | null {
  return (
    db
      .query<SolutionRow, []>(
        `SELECT * FROM solutions ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get() ?? null
  );
}

/** Newest solution for one assignment version — how we know the paper on the
 *  camera has already been solved. */
export function latestSolutionFor(version: number): SolutionRow | null {
  return (
    db
      .query<SolutionRow, [number]>(
        `SELECT * FROM solutions WHERE assignment_version=?1
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(version) ?? null
  );
}

/** Metadata for the glasses' version picker; markdown remains server-side. */
export function recentSolutions(limit = 8): SolutionRow[] {
  return db
    .query<SolutionRow, [number]>(
      `SELECT * FROM solutions ORDER BY created_at DESC, id DESC LIMIT ?1`,
    )
    .all(Math.max(1, Math.min(50, limit)));
}

export function solutionById(id: number): SolutionRow | null {
  return db.query<SolutionRow, [number]>(`SELECT * FROM solutions WHERE id=?1`).get(id) ?? null;
}

export function solutionCount(): number {
  return (
    db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM solutions`).get()?.n ??
    0
  );
}

export { DB_PATH };

// ── reviews ─────────────────────────────────────────────────────────────────
//
// The same lifecycle as a run, over a different subject, on its own queue —
// see the note above the CREATE. Everything below is the mirror image of the
// runs half of this file, and deliberately so: a reviewer that behaves exactly
// like a solver is one set of rules to hold in your head, not two.

export type ReviewState = RunState;

export interface ReviewRow {
  id: number;
  solution_id: number;
  run_id: number | null;
  token: string;
  state: ReviewState;
  round: number;
  model: string | null;
  total: number | null;
  max_total: number | null;
  /** JSON array of per-problem verdicts, exactly as the reviewer posted it. */
  problems: string | null;
  summary: string | null;
  trigger_state: string | null;
  trigger_detail: string | null;
  created_at: number;
  claimed_at: number | null;
  finished_at: number | null;
  error: string | null;
}

export interface NewReview {
  token: string;
  solution_id: number;
  run_id: number | null;
  round: number;
}

/**
 * Supersede every live review and insert a fresh one, in one transaction —
 * the same rule createRun follows, for the same reason. A second review of the
 * same solution (or of the solution that replaced it) makes the first one's
 * verdict obsolete, and its token dies with it.
 */
export const createReview = db.transaction((review: NewReview): ReviewRow => {
  const now = Date.now();
  db.query(
    `UPDATE reviews SET state='superseded', finished_at=?1
      WHERE state IN ${ACTIVE_STATES}`,
  ).run(now);

  return db
    .query<ReviewRow, any[]>(
      `INSERT INTO reviews (solution_id, run_id, token, state, round, created_at)
       VALUES (?1, ?2, ?3, 'pending', ?4, ?5)
       RETURNING *`,
    )
    .get(review.solution_id, review.run_id, review.token, Math.max(1, review.round), now)!;
});

export function activeReview(): ReviewRow | null {
  return (
    db
      .query<ReviewRow, []>(
        `SELECT * FROM reviews WHERE state IN ${ACTIVE_STATES}
          ORDER BY id DESC LIMIT 1`,
      )
      .get() ?? null
  );
}

export function latestReview(): ReviewRow | null {
  return (
    db.query<ReviewRow, []>(`SELECT * FROM reviews ORDER BY id DESC LIMIT 1`).get() ?? null
  );
}

/** The newest finished verdict on one solution — what the AI page's footer reads. */
export function latestReviewFor(solutionId: number): ReviewRow | null {
  return (
    db
      .query<ReviewRow, [number]>(
        `SELECT * FROM reviews WHERE solution_id=?1 AND state='done'
          ORDER BY id DESC LIMIT 1`,
      )
      .get(solutionId) ?? null
  );
}

/**
 * The finished verdict before this one, whatever solution it graded.
 *
 * Not latestReviewFor: a second round grades a NEW solution row (the previous
 * one with the corrected problems spliced in), so the round it has to be
 * compared against is attached to a different solution_id by construction.
 */
export function reviewBefore(id: number): ReviewRow | null {
  return (
    db
      .query<ReviewRow, [number]>(
        `SELECT * FROM reviews WHERE id < ?1 AND state='done' ORDER BY id DESC LIMIT 1`,
      )
      .get(id) ?? null
  );
}

export const claimNextReview = db.transaction((): ReviewRow | null => {
  const row = db
    .query<ReviewRow, []>(
      `SELECT * FROM reviews WHERE state='pending' ORDER BY id ASC LIMIT 1`,
    )
    .get();
  if (!row) return null;
  const now = Date.now();
  db.query(`UPDATE reviews SET state='claimed', claimed_at=?2 WHERE id=?1`).run(row.id, now);
  return { ...row, state: "claimed", claimed_at: now };
});

export function reviewByToken(token: string): ReviewRow | null {
  return (
    db
      .query<ReviewRow, [string]>(
        `SELECT * FROM reviews WHERE token=?1 AND state IN ${ACTIVE_STATES}`,
      )
      .get(token) ?? null
  );
}

export interface ReviewVerdict {
  model: string | null;
  total: number;
  max_total: number;
  /** Serialised whole; nothing here looks inside it. */
  problems: unknown;
  summary: string | null;
}

export function finishReview(
  id: number,
  state: Extract<ReviewState, "done" | "failed" | "cancelled">,
  verdict: ReviewVerdict | null = null,
  error: string | null = null,
): ReviewRow | null {
  return (
    db
      .query<ReviewRow, any[]>(
        `UPDATE reviews
            SET state=?2, model=?3, total=?4, max_total=?5, problems=?6,
                summary=?7, error=?8, finished_at=?9
          WHERE id=?1
        RETURNING *`,
      )
      .get(
        id,
        state,
        verdict?.model ?? null,
        verdict?.total ?? null,
        verdict?.max_total ?? null,
        verdict ? JSON.stringify(verdict.problems) : null,
        verdict?.summary ?? null,
        error,
        Date.now(),
      ) ?? null
  );
}

export function recordReviewTrigger(id: number, state: string, detail: string | null): void {
  db.query(`UPDATE reviews SET trigger_state=?2, trigger_detail=?3 WHERE id=?1`).run(
    id,
    state,
    detail,
  );
}

/** Stand every live review down. What a fresh solve does to a grading in flight. */
export const cancelActiveReviews = db.transaction((reason: string): number => {
  return db.run(
    `UPDATE reviews SET state='cancelled', error=?1, finished_at=?2
      WHERE state IN ${ACTIVE_STATES}`,
    [reason, Date.now()],
  ).changes;
});

// ── hand-written documents ──────────────────────────────────────────────────

export interface DocRow {
  slug: string;
  markdown: string;
  updated_at: number;
}

/**
 * One row per slug, replaced in place.
 *
 * DELIBERATELY NOT the `solutions` table. That one is an append-only log —
 * every solve run adds a row, the AI page shows the newest, and the version
 * picker walks the history. These are the opposite: there is one Adri
 * assignment and one Adri solution, editing IS the update, and a history of
 * drafts would be a list of things nobody asked to keep. Putting both
 * behaviours in one table would mean every reader having to know which kind of
 * row it was looking at.
 *
 * The version the glasses refetch on is a content hash of the markdown, not a
 * counter here — so saving the same text twice costs no render and no BLE push,
 * exactly as it does for every other document in this server.
 */
export function putDoc(slug: string, markdown: string): DocRow {
  return db
    .query<DocRow, [string, string, number]>(
      `INSERT INTO docs (slug, markdown, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(slug) DO UPDATE SET markdown = ?2, updated_at = ?3
       RETURNING *`,
    )
    .get(slug, markdown, Date.now())!;
}

export function getDoc(slug: string): DocRow | null {
  return db.query<DocRow, [string]>(`SELECT * FROM docs WHERE slug=?1`).get(slug) ?? null;
}

// ── settings ────────────────────────────────────────────────────────────────
//
// Device settings that must outlive the device's own storage.
//
// There is exactly one so far — the phone's gallery-bridge URL — and it is here
// because the place it used to live does not hold. The clients keep it in
// localStorage, and the WebView the glasses app runs in does not persist that
// across launches, so the setting was gone every time the app reopened and had
// to be pasted again.
//
// It belongs on this server for a second reason too: the companion app and the
// glasses' Settings page are one web app on one phone that must agree on which
// bridge "the latest photo" comes from. Configured once, configured for both —
// which was already the documented promise (see lookcam/phone/gallery) and is
// only now actually true.

export interface SettingRow {
  key: string;
  value: string;
  updated_at: number;
}

export function getSetting(key: string): string | null {
  return (
    db.query<SettingRow, [string]>(`SELECT * FROM settings WHERE key=?1`).get(key)?.value ??
    null
  );
}

/** An empty value deletes the row: "forget this" and "never set" are one state. */
export function putSetting(key: string, value: string): void {
  if (!value) {
    db.query<unknown, [string]>(`DELETE FROM settings WHERE key=?1`).run(key);
    return;
  }
  db.query<unknown, [string, string, number]>(
    `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3`,
  ).run(key, value, Date.now());
}

// ── messages ────────────────────────────────────────────────────────────────

export type MessageDirection = "out" | "in";

export interface MessageRow {
  id: number;
  body: string;
  direction: MessageDirection;
  created_at: number;
  seen_at: number | null;
}

export function insertMessage(body: string, direction: MessageDirection): MessageRow {
  return db
    .query<MessageRow, [string, MessageDirection, number]>(
      `INSERT INTO messages (body, direction, created_at) VALUES (?1, ?2, ?3) RETURNING *`,
    )
    .get(body, direction, Date.now())!;
}

/**
 * Newest last, so both readers can append without reversing.
 *
 * The website wants a chat log that reads downward and the glasses want the
 * most recent at the bottom of a pager; returning oldest-first serves both,
 * and the LIMIT is applied to the newest rows before the flip.
 */
export function recentMessages(limit = 50): MessageRow[] {
  return db
    .query<MessageRow, [number]>(
      `SELECT * FROM (SELECT * FROM messages ORDER BY created_at DESC, id DESC LIMIT ?1)
       ORDER BY created_at ASC, id ASC`,
    )
    .all(limit);
}

/** Outbound messages the glasses have never displayed, oldest first. */
export function unseenMessages(): MessageRow[] {
  return db
    .query<MessageRow, []>(
      `SELECT * FROM messages WHERE direction='out' AND seen_at IS NULL
       ORDER BY created_at ASC, id ASC`,
    )
    .all();
}

export function unseenCount(): number {
  return (
    db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM messages WHERE direction='out' AND seen_at IS NULL`,
      )
      .get()?.n ?? 0
  );
}

/**
 * Mark everything up to and including `id` as shown on the glasses.
 *
 * Ranged rather than per-id because the banner shows a burst as one queue: if
 * three arrived while the phone was asleep, the glasses display them in order
 * and acknowledge the last. Acknowledging only that one and leaving its
 * predecessors unseen would re-show them on the next connect forever.
 */
export function markMessagesSeen(id: number): number {
  return db.run(
    `UPDATE messages SET seen_at=?1 WHERE direction='out' AND seen_at IS NULL AND id <= ?2`,
    [Date.now(), id],
  ).changes;
}
