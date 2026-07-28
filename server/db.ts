// Persistence for the solve loop: which runs were triggered, and what came
// back. SQLite rather than a file because two things must survive a restart and
// must not be lost by a half-written overwrite:
//
//   runs       one row per "solve this assignment" request, each with the
//              one-time token the agent submits its answer with
//   solutions  every markdown that ever came back, keyed to the assignment
//              version it was solving
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
    -- 'agent' (a solve run) or 'me' (typed in the companion app). See the note
    -- at the migration below for why this is a column and not a magic value
    -- stuffed into the model field.
    source               TEXT    NOT NULL DEFAULT 'agent',
    created_at           INTEGER NOT NULL
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

  CREATE INDEX IF NOT EXISTS runs_state_idx      ON runs(state);
  CREATE INDEX IF NOT EXISTS solutions_recent_idx ON solutions(created_at DESC);
  CREATE INDEX IF NOT EXISTS messages_recent_idx  ON messages(created_at DESC);
`);

/**
 * `source` on a database that predates it.
 *
 * There is no migration framework here and this is the first column ever added,
 * so it is done inline: the CREATE above covers a fresh database, this covers
 * the one already sitting in data/. ADD COLUMN with a DEFAULT is the one shape
 * SQLite rewrites nothing for, and every existing row is genuinely an agent's.
 *
 * It has to be a column rather than a convention on `model`, because the
 * distinction is not cosmetic: `model` is free text from whatever solved the
 * paper, and something that answers "did I write this?" cannot be a string
 * nobody validates. The version picker labels rows with it and the AI page
 * shows the newest solution whatever wrote it, so a mislabelled row is a
 * solution attributed to the wrong author on the glasses.
 */
if (!db.query<{ name: string }, []>(`PRAGMA table_info(solutions)`).all().some((c) => c.name === "source")) {
  db.exec(`ALTER TABLE solutions ADD COLUMN source TEXT NOT NULL DEFAULT 'agent'`);
  console.log("[db] migrated: solutions.source");
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
                         assignment_done, assignment_problems, created_at)
       VALUES (?1, 'pending', ?2, ?3, ?4, ?5, ?6)
       RETURNING *`,
    )
    .get(
      run.token,
      run.assignment_version,
      run.assignment_markdown,
      run.assignment_done ? 1 : 0,
      run.assignment_problems,
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

/**
 * The newest solution you wrote yourself, if any.
 *
 * Separate from latestSolution() on purpose: the companion app's own tab must
 * keep showing YOUR answer after a solve run lands a newer one, or the tab
 * called "my solution" would quietly start displaying the agent's.
 */
export function latestMySolution(): SolutionRow | null {
  return (
    db
      .query<SolutionRow, []>(
        `SELECT * FROM solutions WHERE source='me'
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get() ?? null
  );
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
