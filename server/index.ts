// Document server for the Even Realities glasses app.
//
// Serves two documents through one markdown → PNG tile pipeline, so the glasses
// client stays thin (no marked/MathJax/html2canvas on-device):
//
//   the AI document                      assignment (lookcam reader, live)
//   GET /markdown                        GET  /assignment/markdown
//   GET /tiles                           GET  /assignment/tiles
//   GET /events                          GET  /assignment/events
//   GET /solution/status                 GET  /assignment/status
//   POST /solution/solve                 POST /assignment/toggle
//   POST /solution/cancel                POST /assignment/control
//                                        GET  /assignment/archive
//                                        POST /assignment/active
//
// Both documents take `?overlay=menu` (the same page with the action menu's
// rectangle darkened, so the menu can open without hiding the document) and a
// history selector: `?solution_id=` for the AI page, `?version=` for the
// assignment's earlier scans.
// Two more documents are neither: markdown you type yourself (PUT /doc/:slug),
// stored one row per slug, read back on the glasses. One version each — editing
// IS the update, so there is no history and no `?version=`.
//
//   /adri/*   the Adri sheet and answer      slug adri-assignment, adri-solution
//   /mine/*   your own working on the        slug my-solution
//             assignment the camera read
//
//   GET  /solution/claim   ─┐ the Claude routine's side of the solve loop
//   POST /solution/submit   │ (see solver.ts) — token-gated, not for the glasses
//   POST /solution/fail    ─┘
//
//   GET  /review/claim     ─┐ the reviewer routine's side of the review loop
//   POST /review/submit     │ (see review.ts): it grades what the solver wrote
//   POST /review/fail       │ and the problems that fall short come back to the
//   GET  /review/status    ─┘ solve queue as a revision run
//
// The assignment is also renderable as ordinary images rather than BLE tiles —
// `/assignment/sheet*` — which is what the camera site's Assignment tab shows
// and what "download the assignment" saves.
//
// The AI document is whatever Claude last solved (SQLite, see db.ts), falling
// back to the repo's solution.md until something has been. Both are watched, so
// either changing pushes new tiles.
//
// `version` is what the client refetches on: a content hash for both remote
// documents (the reader's own `version` field only bumps on /reset, so it would
// never signal an individual capture's edits), the file mtime for solution.md.
//
// Run with: bun run index.ts   (or `bun run dev` to auto-restart on edits)

import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createTileCache, type DocSource, type Snapshot } from "./doc";
import {
  archivedSource,
  assignmentSource,
  cameraConfigured,
  control,
  fetchFrame,
  getArchive,
  setActiveVersion,
  getPublishedPhoto,
  getStatus,
  isConfigured as assignmentConfigured,
  PHOTO_TYPES,
  publishPhoto,
  publishText,
  readClaim,
  readFail,
  readFrameImage,
  readSubmit,
  startUpstream,
  subscribeStatus,
  toggle,
  CONTROL_ACTIONS,
  type ControlAction,
} from "./assignment";
import {
  PREVIEW_MODES,
  renderCameraTiles,
  ROTATIONS,
  type CameraPreview,
  type PreviewMode,
  type PreviewSize,
} from "./render/camera";
import { createSheetCache } from "./render/sheet";
import {
  authorizeSolver,
  cancelRun,
  claimRun,
  createAiSource,
  failRun,
  getSolverStatus,
  reviewLatest,
  solverTokenRequired,
  startRun,
  submitSolution,
  subscribeSolver,
} from "./solver";
import {
  claimReview,
  description as reviewDescription,
  failReview,
  getReviewStatus,
  submitReview,
} from "./review";
import { HUD_FEEDBACK, HUD_FEEDBACK_LARGE, HUD_MENU, type Rect } from "./render/constants";
import { DB_PATH, getSetting, putSetting } from "./db";
import {
  getMessageStatus,
  markSeen,
  messageStreamClosed,
  messageStreamOpened,
  normalise,
  QUICK_REPLIES,
  recentMessages,
  send,
  subscribeMessages,
} from "./messages";
import { docSource, isDocSlug, readDoc, saveDoc } from "./docs";
import { triggerDescription } from "./trigger";
import { description as backupDescription } from "./backup";

const __dirname = dirname(fileURLToPath(import.meta.url));
// solution.md lives in the repo root, one level up from server/.
const MARKDOWN_PATH = resolve(__dirname, "..", "solution.md");
const PORT = Number(process.env.PORT ?? 8787);

// ── keeping the SSE streams alive ───────────────────────────────────────────
//
// Bun.serve closes a connection after `idleTimeout` seconds without activity,
// and the DEFAULT IS 10. Every /events stream in this app was therefore being
// killed by its own server before its first heartbeat — the client reconnected,
// got killed again, and the glasses lived on a stream that was never up for
// more than ten seconds at a time. The visible symptom was the AI page still
// saying CLAUDE IS SOLVING long after the routine had submitted: the status
// event that says otherwise is pushed once, and there was frequently no stream
// attached to push it down.
//
// The log line is the only evidence, and it is easy to read as a slow client:
//
//   [Bun.serve]: request timed out after 10 seconds. Pass `idleTimeout` to configure.
//
// So: a heartbeat well inside the timeout, and a timeout long enough that the
// heartbeat is what keeps the connection up rather than what races it.
const HEARTBEAT_MS = 10_000;
/** Seconds. Bun caps this at 255; 0 would disable the timeout entirely. */
const IDLE_TIMEOUT_S = 120;

// ── solution.md: the file-backed source ─────────────────────────────────────

async function readFileSnapshot(): Promise<Snapshot> {
  const [content, info] = await Promise.all([
    readFile(MARKDOWN_PATH, "utf8"),
    stat(MARKDOWN_PATH),
  ]);
  return { content, version: Math.floor(info.mtimeMs) };
}

// Fan out file-change notifications to all connected SSE clients.
const fileListeners = new Set<() => void>();

// fs.watch can emit several events per save (and occasionally rename events on
// atomic writes); debounce so clients see one update per logical change.
let debounce: ReturnType<typeof setTimeout> | null = null;
watch(MARKDOWN_PATH, () => {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    for (const notify of fileListeners) notify();
  }, 100);
});

const fileSource: DocSource = {
  name: "solution",
  read: readFileSnapshot,
  subscribe(onChange) {
    fileListeners.add(onChange);
    return () => fileListeners.delete(onChange);
  },
};

// What the AI page shows: Claude's latest solution, or solution.md until there
// is one. The file stays watched either way, so editing it by hand still pushes.
const aiSource = createAiSource(fileSource);
const aiSources = new Map<string, DocSource>([["latest", aiSource]]);
const aiTileCaches = new Map<string, ReturnType<typeof createTileCache>>();
function selectedAiSource(c: Context): { key: string; source: DocSource } {
  const raw = c.req.query("solution_id");
  const id = raw === undefined || raw === "" ? undefined : Number(raw);
  const key = id !== undefined && Number.isInteger(id) && id > 0 ? String(id) : "latest";
  let source = aiSources.get(key);
  if (!source) {
    source = createAiSource(fileSource, Number(key));
    aiSources.set(key, source);
  }
  return { key, source };
}
/**
 * `?overlay=menu` renders the same document with the action menu's rectangle
 * dark and framed, so the glasses can open the menu without blacking out the
 * solution behind it. Same pages, same pagination — only the reserved box
 * differs, which is what lets the client swap tiles for the page it is already
 * on. See HUD_MENU.
 */
function aiOverlay(c: Context): {
  overlay: string | null;
  suffix: string;
  reserved: Rect[];
} {
  return c.req.query("overlay") === "menu"
    ? { overlay: "menu", suffix: ":menu", reserved: [HUD_MENU] }
    : { overlay: null, suffix: "", reserved: [] };
}

function aiTiles(key: string, source: DocSource, reserved: Rect[] = []) {
  let get = aiTileCaches.get(key);
  if (!get) {
    get = createTileCache(source, { reserved });
    aiTileCaches.set(key, get);
  }
  return get;
}
// The assignment page keeps a permanent panel in the bottom-right corner (the
// model's camera advice). A text container is transparent, so the background
// has to come from the tile itself — the client has no spare image layer to put
// underneath. The AI page has no such panel, so its tiles are untouched.
//
// `?version=` picks an archived scan (the reader's /archive) and `?overlay=menu`
// adds the action menu's box on top of the advice box, exactly as on the AI
// page. Both are cache keys, so a page rendered five ways is five entries.
const assignmentTileCaches = new Map<string, ReturnType<typeof createTileCache>>();

function selectedAssignment(c: Context): { key: string; source: DocSource } {
  const raw = c.req.query("version");
  const version = raw === undefined || raw === "" ? NaN : Number(raw);
  // The live attempt is served by the live source whether or not it was asked
  // for by number — the archive's copy of it would stop updating mid-scan.
  if (
    !Number.isInteger(version) ||
    version <= 0 ||
    version === getStatus().version
  ) {
    return { key: "live", source: assignmentSource };
  }
  return { key: `v${version}`, source: archivedSource(version) };
}

function assignmentTiles(key: string, source: DocSource, reserved: Rect[]) {
  let get = assignmentTileCaches.get(key);
  if (!get) {
    get = createTileCache(source, { reserved });
    assignmentTileCaches.set(key, get);
  }
  return get;
}

// ── routes ──────────────────────────────────────────────────────────────────

const app = new Hono();

// The app is served from the Vite dev origin (a different port), so allow CORS.
app.use("*", cors());

/**
 * A page's out-of-band state: the assignment's job/camera status, the AI page's
 * solve status. Pushed separately from the document because it changes several
 * times per capture (or per solve) while the document often doesn't, and a text
 * container upgrade is far cheaper than four tiles over BLE.
 */
interface StatusFeed {
  get(): unknown | Promise<unknown>;
  subscribe(onChange: () => void): () => void;
}

/**
 * SSE for one document. Emits `markdown` with `{ content, version }` on connect
 * and on every change; `ping` heartbeats keep proxies from timing the stream
 * out. With a `status` feed, also emits `status` on every change to it.
 */
function documentStream(source: DocSource, statusFeed?: StatusFeed) {
  return (c: Context) =>
    streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });

      // Writes come from three places (document changes, status changes, the
      // heartbeat loop) and must not interleave on the wire.
      let chain: Promise<void> = Promise.resolve();
      const write = (event: string, data: string): Promise<void> => {
        chain = chain
          .then(async () => {
            if (closed) return;
            await stream.writeSSE({ event, data });
          })
          .catch(() => {
            closed = true;
          });
        return chain;
      };

      const sendDoc = async () => {
        try {
          await write("markdown", JSON.stringify(await source.read()));
        } catch (err) {
          console.error(`[${source.name}] SSE read failed:`, err);
        }
      };
      const sendStatus = async () => {
        try {
          await write("status", JSON.stringify(await statusFeed!.get()));
        } catch (err) {
          console.error(`[${source.name}] SSE status failed:`, err);
        }
      };

      const unsubscribeDoc = source.subscribe(() => void sendDoc());
      const unsubscribeStatus = statusFeed
        ? statusFeed.subscribe(() => void sendStatus())
        : null;

      // Push the current state immediately so a fresh subscriber is in sync.
      // Status first: if the document is unavailable (reader down, nothing
      // captured yet) the client still learns why.
      if (statusFeed) await sendStatus();
      await sendDoc();

      try {
        while (!closed) {
          await write("ping", "");
          await stream.sleep(HEARTBEAT_MS);
        }
      } finally {
        unsubscribeDoc();
        unsubscribeStatus?.();
      }
    });
}

// ── the app's log ───────────────────────────────────────────────────────────
//
// The glasses have no console. Whatever the bridge refuses — a page rebuild the
// host rejected, a tile push that didn't land — is invisible on the device and
// obvious in the simulator, which is precisely backwards from where the bugs
// live. So the app ships its log here (see test/src/debug.ts) and `curl /log`
// reads it back.
//
// In memory and bounded: this is a debug aid, not a record. It resets on restart.

// ── health ──────────────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ ok: true, backend: "online" }));

// ── logging ─────────────────────────────────────────────────────────────────

const LOG_CAPACITY = 500;
const appLogLines: string[] = [];

app.post("/log", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    source?: unknown;
    lines?: unknown;
  };
  const source = typeof body.source === "string" ? body.source.slice(0, 16) : "app";
  const lines = Array.isArray(body.lines) ? body.lines : [];
  for (const line of lines.slice(0, 100)) {
    appLogLines.push(`${source} ${String(line).slice(0, 500)}`);
  }
  while (appLogLines.length > LOG_CAPACITY) appLogLines.shift();
  return c.json({ ok: true, held: appLogLines.length });
});

app.get("/log", (c) => {
  const tail = Number(c.req.query("tail") ?? 200);
  return c.text(appLogLines.slice(-Math.max(1, tail)).join("\n") + "\n");
});

app.delete("/log", (c) => {
  appLogLines.length = 0;
  return c.json({ ok: true });
});

app.get("/markdown", async (c) => {
  try {
    return c.json(await selectedAiSource(c).source.read());
  } catch (err) {
    console.error("read AI document failed:", err);
    return c.json({ error: "markdown_unavailable" }, 500);
  }
});

app.get("/tiles", async (c) => {
  try {
    const { key, source } = selectedAiSource(c);
    const { overlay, suffix, reserved } = aiOverlay(c);
    const tiles = await aiTiles(key + suffix, source, reserved)();
    // Echoed, so the client can tell "here are your masked tiles" from "I have
    // never heard of ?overlay and ignored it". The glasses app ships to a
    // device and updates on its own schedule, so it WILL at some point ask a
    // server older than itself — and a variant that is silently the plain
    // document is worse than no variant at all: the menu draws transparent over
    // a document it was supposed to have covered.
    return c.json({ ...tiles, overlay });
  } catch (err) {
    console.error("render tiles failed:", err);
    return c.json({ error: "tiles_unavailable" }, 500);
  }
});

app.get("/events", (c) => {
  const { source } = selectedAiSource(c);
  return documentStream(source, { get: getSolverStatus, subscribe: subscribeSolver })(c);
});

// ── the solve loop ──────────────────────────────────────────────────────────
//
// Two audiences, deliberately separated:
//
//   the glasses  /solution/status, /solve, /cancel — no secret, same as the
//                assignment controls, because the app ships to a device and
//                can't hold one
//   the routine  /solution/claim, /submit, /fail — gated, because they hand out
//                the assignment and accept what gets displayed on the glasses

// Everything the agent does arrives here, and when it goes wrong it goes wrong
// silently — a 401 from a mistyped token looks exactly like an agent that never
// ran. Caddy in this stack logs errors only, so this is the one place that can
// say "something knocked". Status polling is the glasses and would drown it.
app.use("/solution/*", async (c, next) => {
  const path = c.req.path;
  const quiet = path === "/solution/status";
  await next();
  if (quiet) return;
  console.log(
    `[solver] ${c.req.method} ${path} -> ${c.res.status}` +
      ` (${c.req.header("x-forwarded-for") ?? "direct"})`,
  );
});

app.get("/solution/status", async (c) => c.json(await getSolverStatus()));

// The trigger button. Records the run, then kicks the routine; a run that
// couldn't be triggered is still queued, and the response says which happened.
app.post("/solution/solve", async (c) => {
  const result = await startRun();
  return c.json(result, result.ok ? 200 : 409);
});

app.post("/solution/cancel", (c) => {
  const result = cancelRun();
  return c.json(result, result.ok ? 200 : 409);
});

/** The routine's shared secret, in a header or `?token=`. */
function solverAuthorized(c: Context): boolean {
  const header =
    c.req.header("x-solver-token") ??
    c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
    c.req.query("token");
  return authorizeSolver(header);
}

app.use("/solution/claim", async (c, next) => {
  if (!solverAuthorized(c)) return c.json({ ok: false, reason: "unauthorized" }, 401);
  await next();
});

/**
 * The routine's first call: it gets the assignment text *and* the one-time token
 * it must submit with. 200 with `ok: false` when the queue is empty — a cron run
 * that finds nothing to do should exit cleanly, not treat it as an error.
 */
app.get("/solution/claim", (c) => c.json(claimRun()));

/** The submit token identifies the run, so these need no other secret. */
function runToken(c: Context, body: Record<string, unknown>): string {
  return String(
    c.req.header("x-run-token") ??
      c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
      body.run_token ??
      body.token ??
      "",
  );
}

/**
 * `sections` on a revision: `{"4": "## 4 …", "7": "## 7 …"}`. Only strings,
 * only non-empty ones — a key mapped to null would splice a hole into the
 * document where a corrected problem should be.
 */
function submittedSections(body: Record<string, unknown>): Record<string, string> | undefined {
  const raw = body.sections;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim()) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

app.post("/solution/submit", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = submitSolution(runToken(c, body), {
    markdown: typeof body.markdown === "string" ? body.markdown : "",
    sections: submittedSections(body),
    model: typeof body.model === "string" ? body.model : null,
    notes: typeof body.notes === "string" ? body.notes : null,
  });
  // 409, not 401: a superseded token is a race the agent lost, not a bad
  // credential — you tapped again while it was working.
  return c.json(result, result.ok ? 200 : 409);
});

app.post("/solution/fail", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = failRun(runToken(c, body), String(body.error ?? ""));
  return c.json(result, result.ok ? 200 : 409);
});

/**
 * Grade the newest solution by hand.
 *
 * Reviews normally start themselves, the moment an answer lands. This is for the
 * cases that never went through that: a solution submitted while the reviewer
 * was misconfigured, or one you want a second opinion on. Ungated like /solve —
 * it grades your own solution, it doesn't hand anything out.
 */
app.post("/solution/review", async (c) => {
  const result = await reviewLatest();
  return c.json(result, result.ok ? 200 : 409);
});

// ── the review loop ─────────────────────────────────────────────────────────
//
// The reviewer's half, gated exactly as the solver's is and for the same
// reasons: /review/claim hands out an assignment and a solution, and
// /review/submit decides whether more money gets spent re-solving.

app.use("/review/*", async (c, next) => {
  if (c.req.path === "/review/claim" && !solverAuthorized(c)) {
    return c.json({ ok: false, reason: "unauthorized" }, 401);
  }
  await next();
  console.log(
    `[review] ${c.req.method} ${c.req.path} -> ${c.res.status}` +
      ` (${c.req.header("x-forwarded-for") ?? "direct"})`,
  );
});

app.get("/review/claim", (c) => c.json(claimReview()));

/** The review token identifies the review, so these need no other secret. */
function reviewTokenOf(c: Context, body: Record<string, unknown>): string {
  return String(
    c.req.header("x-review-token") ??
      c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
      body.review_token ??
      body.token ??
      "",
  );
}

app.post("/review/submit", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await submitReview(reviewTokenOf(c, body), body);
  return c.json(result, result.ok ? 200 : 409);
});

app.post("/review/fail", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = failReview(reviewTokenOf(c, body), String(body.error ?? ""));
  return c.json(result, result.ok ? 200 : 409);
});

app.get("/review/status", (c) => c.json(getReviewStatus()));

// ── assignment ──────────────────────────────────────────────────────────────

// Without ASSIGNMENT_URL the feature is simply absent; say so plainly rather
// than leaving the glasses on a stream that never emits.
app.use("/assignment/*", async (c, next) => {
  if (!assignmentConfigured()) {
    return c.json(
      { error: "assignment_not_configured", detail: "set ASSIGNMENT_URL" },
      503,
    );
  }
  await next();
});

// ── the batch-read loop ─────────────────────────────────────────────────────
//
// The reading routine's four calls, proxied to the reader (assignment.ts).
// Gated with SOLVER_TOKEN — the same secret the solve routine already carries,
// because it is the same kind of caller and a second one would be a second
// thing to rotate. This is the ONE part of /assignment/* that isn't for the
// glasses, so the gate sits here rather than on the family.
//
// Ordered before the glasses' routes only for readability; Hono matches on the
// exact path either way.
app.use("/assignment/read/*", async (c, next) => {
  if (!solverAuthorized(c)) return c.json({ ok: false, reason: "unauthorized" }, 401);
  await next();
  console.log(
    `[read] ${c.req.method} ${c.req.path} -> ${c.res.status}` +
      ` (${c.req.header("x-forwarded-for") ?? "direct"})`,
  );
});

/** 200 with `ok: false` when no batch is waiting — a routine that fires on a
 *  schedule, or for a read that has since timed out, must exit cheaply. */
app.get("/assignment/read/claim", async (c) => {
  try {
    return c.json((await readClaim()) as object);
  } catch (err) {
    console.error("read claim failed:", err);
    return c.json({ ok: false, reason: "reader_unavailable" }, 502);
  }
});

/** One snapshot, streamed through as-is. The agent saves it to a file and reads
 *  it as an image — this is the only reason the routine needs network at all. */
app.get("/assignment/read/frame/:n", async (c) => {
  const n = Number(c.req.param("n"));
  if (!Number.isInteger(n) || n < 1) {
    return c.json({ ok: false, error: "frame must be a positive integer" }, 400);
  }
  try {
    const res = await readFrameImage(n);
    if (!res.ok) return c.json((await res.json().catch(() => ({}))) as object, res.status as 400);
    return new Response(res.body, {
      status: 200,
      headers: {
        "content-type": res.headers.get("content-type") ?? "image/jpeg",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    console.error("read frame failed:", err);
    return c.json({ ok: false, error: "reader_unavailable" }, 502);
  }
});

// 409 rather than 401 on a stale token, for the reason /solution/submit says:
// losing a race is not a bad credential. Here the race is against the deadline —
// the model chain has already read the batch this answer is for.
app.post("/assignment/read/submit", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const res = await readSubmit(body);
    return c.json((await res.json().catch(() => ({}))) as object, res.status as 200);
  } catch (err) {
    console.error("read submit failed:", err);
    return c.json({ ok: false, error: "reader_unavailable" }, 502);
  }
});

app.post("/assignment/read/fail", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const res = await readFail(body);
    return c.json((await res.json().catch(() => ({}))) as object, res.status as 200);
  } catch (err) {
    console.error("read fail failed:", err);
    return c.json({ ok: false, error: "reader_unavailable" }, 502);
  }
});

app.get("/assignment/markdown", async (c) => {
  try {
    return c.json(await selectedAssignment(c).source.read());
  } catch (err) {
    console.error("read assignment failed:", err);
    return c.json({ error: "assignment_unavailable" }, 502);
  }
});

app.get("/assignment/tiles", async (c) => {
  try {
    const { key, source } = selectedAssignment(c);
    const menu = c.req.query("overlay") === "menu";
    // Only the menu's box, and only on the overlay variant.
    //
    // The advice box used to be reserved on EVERY render, which meant a dark
    // 288×76 rectangle baked into the bottom right of every page of every
    // transcription. The Assignment page no longer draws text there (its corner
    // box is gone — the footer said the same things a whole line wider), and a
    // reserved rect with nothing in it is just a hole punched in the document.
    //
    // The camera preview still reserves it: that page kept its box, because
    // camera advice is the thing you act on while aiming.
    const reserved = menu ? [HUD_MENU] : [];
    const tiles = await assignmentTiles(
      menu ? `${key}:menu` : key,
      source,
      reserved,
    )();
    // Echoed for the same reason the AI page echoes it: a client must be able
    // to tell a masked render from a server that ignored the query.
    return c.json({ ...tiles, overlay: menu ? "menu" : null });
  } catch (err) {
    console.error("render assignment tiles failed:", err);
    return c.json({ error: "tiles_unavailable" }, 502);
  }
});

// ── the camera preview ──────────────────────────────────────────────────────
//
// What the camera sees now, as tiles. The Camera page polls this while you aim
// the paper — so unlike every other tile route there is nothing to cache off a
// version: the whole point is that the picture changed.
//
// Renders are coalesced instead. Two glasses (or a poll that overlaps the
// previous one) share one frame grab and one sharp run; the TTL is short enough
// that nobody is shown a frame they'd call stale, and long enough that the
// camera stack isn't asked for a frame per viewer.
const PREVIEW_TTL_MS = Number(process.env.CAMERA_PREVIEW_TTL_MS ?? 700);

interface PreviewEntry {
  at: number;
  preview: CameraPreview;
}
const previewCache = new Map<string, PreviewEntry>();
const previewInFlight = new Map<string, Promise<CameraPreview>>();

async function cameraPreview(
  size: PreviewSize,
  rotate: number,
  mode: PreviewMode,
  menu: boolean,
): Promise<CameraPreview> {
  const key = `${size}:${rotate}:${mode}:${menu ? "menu" : "plain"}`;
  const hit = previewCache.get(key);
  if (hit && Date.now() - hit.at <= PREVIEW_TTL_MS) return hit.preview;

  let pending = previewInFlight.get(key);
  if (!pending) {
    pending = (async () => {
      // Ask for a frame no older than the cache we're about to write, so the
      // two staleness budgets don't stack.
      const jpeg = await fetchFrame(PREVIEW_TTL_MS);
      const preview = await renderCameraTiles(jpeg, {
        size,
        rotate,
        mode,
        // The advice panel sits over the bottom-right tile here exactly as it
        // does on the assignment page, so it needs the same baked background.
        // With the action menu open its box is reserved too — that is what lets
        // the camera stay live and visible around a menu you are reading.
        reserved:
          size === 4
            ? (menu ? [HUD_FEEDBACK, HUD_MENU] : [HUD_FEEDBACK])
            : (menu ? [HUD_FEEDBACK_LARGE, HUD_MENU] : [HUD_FEEDBACK_LARGE]),
      });
      previewCache.set(key, { at: Date.now(), preview });
      return preview;
    })().finally(() => previewInFlight.delete(key));
    previewInFlight.set(key, pending);
  }
  return pending;
}

app.get("/assignment/camera", async (c) => {
  if (!cameraConfigured()) {
    return c.json(
      { error: "camera_not_configured", detail: "set ASSIGNMENT_URL or CAMERA_SNAPSHOT_URL" },
      503,
    );
  }

  const size = c.req.query("size") === "1" ? 1 : 4;
  const rotate = Number(c.req.query("rotate") ?? 0);
  if (!ROTATIONS.includes(rotate as (typeof ROTATIONS)[number])) {
    return c.json({ error: "bad_rotation", detail: `use one of ${ROTATIONS.join(", ")}` }, 400);
  }

  const mode = (c.req.query("mode") ?? "ink") as PreviewMode;
  if (!PREVIEW_MODES.includes(mode)) {
    return c.json({ error: "bad_mode", detail: `use one of ${PREVIEW_MODES.join(", ")}` }, 400);
  }

  try {
    const { tiles, contrast } = await cameraPreview(
      size,
      rotate,
      mode,
      c.req.query("overlay") === "menu",
    );
    return c.json({ tiles, size, rotate, mode, contrast, at: Date.now() });
  } catch (err) {
    // Expected whenever the stream isn't publishing, so it is a message to put
    // on the glasses rather than a stack trace to hunt for.
    const detail = err instanceof Error ? err.message : String(err);
    console.error("camera preview failed:", detail);
    return c.json({ error: "camera_unavailable", detail }, 502);
  }
});

// ── the assignment as ordinary images ───────────────────────────────────────
//
// The same document the glasses read, rendered for a screen and a download
// instead of for BLE: one PNG per page (exactly what the glasses show, seams
// and all — see render/sheet.ts) and one tall PNG of the whole thing.
//
// This is what the camera site's Assignment tab is built on. It is the answer
// to "let me actually read the transcription before I spend a solve on it",
// which the glasses cannot be, and to "keep a copy of this sheet".
//
// One cache per selected scan, exactly as the tile routes do it — `?version=`
// picks an archived scan and the live one renders under its own key.

const sheetCaches = new Map<string, ReturnType<typeof createSheetCache>>();

/** Which scan is being rendered, and its sheet. */
async function assignmentSheet(c: Context) {
  const { key, source } = selectedAssignment(c);
  let get = sheetCaches.get(key);
  if (!get) {
    get = createSheetCache(source);
    sheetCaches.set(key, get);
  }
  // The reader's attempt number — what the picker labels a scan with. A sheet's
  // own `version` is the content hash it caches on, and the two are different
  // numbering systems (see the note on SolverStatus.assignment).
  const scan = key === "live" ? getStatus().version : Number(key.slice(1));
  return { sheet: await get(), scan };
}

/** The filename a download lands under. Sanitised: it goes in a header. */
function sheetName(scan: number, suffix: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `assignment-v${scan}-${stamp}${suffix}`;
}

/** What there is to show: how many pages, how big, and which scan it is. */
app.get("/assignment/sheet", async (c) => {
  try {
    const { sheet, scan } = await assignmentSheet(c);
    return c.json({
      version: sheet.version,
      scan,
      pages: sheet.pages.length,
      page_width: sheet.page_width,
      page_height: sheet.page_height,
      full_width: sheet.full_width,
      full_height: sheet.full_height,
      scale: sheet.scale,
      bytes: sheet.full.length,
    });
  } catch (err) {
    console.error("render assignment sheet failed:", err);
    return c.json({ error: "sheet_unavailable", detail: String(err) }, 502);
  }
});

/** The whole assignment, one image. `?download=1` saves it instead of showing it. */
app.get("/assignment/sheet.png", async (c) => {
  try {
    const { sheet, scan } = await assignmentSheet(c);
    const headers: Record<string, string> = {
      "content-type": "image/png",
      "content-length": String(sheet.full.length),
      // The content hash IS the version, so a render can be cached hard and a
      // new scan simply asks for a different URL.
      "cache-control": "no-cache",
      etag: `"${sheet.version}"`,
    };
    if (c.req.query("download") === "1") {
      headers["content-disposition"] = `attachment; filename="${sheetName(scan, ".png")}"`;
    }
    return new Response(new Uint8Array(sheet.full), { headers });
  } catch (err) {
    console.error("render assignment sheet failed:", err);
    return c.json({ error: "sheet_unavailable", detail: String(err) }, 502);
  }
});

/**
 * One page, as the glasses show it. `/assignment/sheet/2.png` — the extension is
 * part of the parameter rather than the route, and that is not cosmetic:
 * Hono's RegExpRouter cannot build a matcher for a constrained param followed by
 * a literal in the same segment (`:page{[0-9]+}.png`). It does not fail on that
 * route — it throws while building ALL of them, on the first request, so every
 * endpoint on the server 500s with a TypeError from inside the router. Keep the
 * suffix out of the pattern.
 */
app.get("/assignment/sheet/:page", async (c) => {
  try {
    const { sheet, scan } = await assignmentSheet(c);
    const index = Number(c.req.param("page").replace(/\.png$/i, ""));
    const page = Number.isInteger(index) ? sheet.pages[index] : undefined;
    if (!page) {
      return c.json({ error: "no_such_page", pages: sheet.pages.length }, 404);
    }
    const headers: Record<string, string> = {
      "content-type": "image/png",
      "content-length": String(page.png.length),
      "cache-control": "no-cache",
      etag: `"${sheet.version}-${index}"`,
    };
    if (c.req.query("download") === "1") {
      headers["content-disposition"] =
        `attachment; filename="${sheetName(scan, `-p${index + 1}.png`)}"`;
    }
    return new Response(new Uint8Array(page.png), { headers });
  } catch (err) {
    console.error("render assignment page failed:", err);
    return c.json({ error: "sheet_unavailable", detail: String(err) }, 502);
  }
});

app.get("/assignment/status", (c) => c.json(getStatus()));

/** The reader's scan history, as the glasses' version picker sees it. */
app.get("/assignment/archive", (c) => c.json({ versions: getArchive() }));

/**
 * Point the solve button at one scan, or back at the live one.
 *
 * `{"version": null}` follows the camera — the default, and where a reset puts
 * it back. `{"version": 7}` pins it to that filed-away scan, so the button
 * solves a sheet you photographed earlier without pointing the camera at it
 * again. Ungated like the rest of /assignment/*: it decides which of your own
 * scans gets solved, not who may solve one.
 */
app.post("/assignment/active", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const raw = body.version;
  if (raw !== null && typeof raw !== "number") {
    return c.json(
      { ok: false, reason: "version must be a number, or null to follow live" },
      400,
    );
  }
  const result = setActiveVersion(raw);
  return c.json(result, result.ok ? 200 : 404);
});

app.get("/assignment/events", (c) =>
  documentStream(selectedAssignment(c).source, {
    get: getStatus,
    subscribe: subscribeStatus,
  })(c),
);

// The tap gesture: let the server pick start / stop / restart.
app.post("/assignment/toggle", async (c) => {
  const result = await toggle();
  return c.json(result, result.ok ? 200 : 502);
});

// The menu: the glasses name the action outright. The list of what's allowed
// comes from assignment.ts so adding an action there is enough to make it
// reachable.
app.post("/assignment/control", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const action = (body as { action?: string }).action;
  if (!CONTROL_ACTIONS.includes(action as ControlAction)) {
    return c.json(
      { ok: false, action: "failed", detail: `unknown action "${action}"` },
      400,
    );
  }
  const result = await control(action as ControlAction);
  return c.json(result, result.ok ? 200 : 502);
});

// ── hand-written documents (the Adri page) ──────────────────────────────────
//
// A sheet you state yourself and an answer you write yourself, both edited in
// the companion app. There is exactly ONE of each — saving replaces it — so
// there is no history to page through and no `?version=` here.
//
// `/doc/:slug` is the editing surface. `/adri/*` is the reading surface, and it
// is the same shape as `/assignment/*` and `/tiles` because the glasses page is
// an ordinary document page: same tile pipeline, same SSE, same client code.

const adriSource = docSource("adri-solution");
const adriTiles = createTileCache(adriSource);
/** The overlay variant, for when the glasses open a menu over the document. */
const adriMenuTiles = createTileCache(adriSource, { reserved: [HUD_MENU] });

// ── settings ────────────────────────────────────────────────────────────────
//
// Small strings a device configures once and must find again on the next
// launch. Today that is one: where the phone's gallery bridge is.
//
// It is here rather than in the client's localStorage because the WebView the
// glasses app runs in does not keep localStorage across launches — the URL was
// gone every reopen and had to be pasted again. Storing it server-side also
// makes good on what the setup docs already claimed: the companion app and the
// glasses' Settings page are one web app on one phone, so configuring the
// bridge once configures both.
//
// A FIXED KEY LIST, not "any key you PUT", for the reason DOC_SLUGS is one: a
// key nothing reads is a setting you can write and never see, and an open
// endpoint turns a typo into a silent second setting.
//
// NOT SECRET-GRADE STORAGE. The bridge URL carries the gallery token, and this
// server has no auth on ordinary routes, so treat it as readable by anything
// that can reach the server. The token is only useful from that phone's own
// loopback — it authorises 127.0.0.1:8790, which nothing else can route to —
// so what leaks is the fact of the bridge, not access to the camera roll.
const SETTING_KEYS = ["gallery-bridge", "mode"] as const;
const isSettingKey = (key: string): boolean =>
  (SETTING_KEYS as readonly string[]).includes(key);

app.get("/settings/:key", (c) => {
  const key = c.req.param("key");
  if (!isSettingKey(key)) return c.json({ error: "unknown_setting", key }, 404);
  return c.json({ key, value: getSetting(key) ?? "" });
});

app.put("/settings/:key", async (c) => {
  const key = c.req.param("key");
  if (!isSettingKey(key)) return c.json({ error: "unknown_setting", key }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { value?: unknown };
  if (typeof body.value !== "string") {
    return c.json({ ok: false, reason: "value must be a string" }, 400);
  }
  // Length-capped because nothing here should ever be long, and an endpoint
  // that accepts a megabyte of anything is a place to park a megabyte.
  const value = body.value.trim();
  if (value.length > 2048) return c.json({ ok: false, reason: "value too long" }, 400);

  putSetting(key, value);
  return c.json({ ok: true, key, value });
});

app.get("/doc/:slug", (c) => {
  const slug = c.req.param("slug");
  if (!isDocSlug(slug)) return c.json({ error: "unknown_document", slug }, 404);
  return c.json(readDoc(slug));
});

app.put("/doc/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (!isDocSlug(slug)) return c.json({ error: "unknown_document", slug }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { markdown?: unknown };
  if (typeof body.markdown !== "string") {
    return c.json({ ok: false, reason: "markdown must be a string" }, 400);
  }
  const result = saveDoc(slug, body.markdown);
  if (!result.ok) return c.json(result, 400);

  // The Adri TASK is an assignment, so it becomes one: published upstream as a
  // new version, archiving the previous attempt exactly as a photo or a scan
  // does. Everything downstream then treats it as the assignment — the glasses'
  // Assignment page, the archive, and the solve button — because it is one.
  //
  // Only when the text actually changed. Pressing Save twice would otherwise
  // file a second identical version, and the archive is the one thing here you
  // cannot tidy up from the glasses.
  //
  // The answer is not published: a solution is not an assignment, and the
  // glasses read that one off /adri.
  if (slug === "adri-assignment" && result.changed && body.markdown.trim()) {
    const published = await publishText(body.markdown);
    return c.json({ ...result, assignment: published });
  }
  return c.json(result);
});

app.get("/adri/markdown", async (c) => c.json(await adriSource.read()));

app.get("/adri/tiles", async (c) => {
  try {
    const menu = c.req.query("overlay") === "menu";
    const tiles = await (menu ? adriMenuTiles : adriTiles)();
    return c.json({ ...tiles, overlay: menu ? "menu" : null });
  } catch (err) {
    console.error("render adri tiles failed:", err);
    return c.json({ error: "tiles_unavailable" }, 502);
  }
});

app.get("/adri/events", (c) => documentStream(adriSource)(c));

// ── your own solution (the Mine page) ───────────────────────────────────────
//
// The same three routes over a different slug, because it is the same kind of
// thing: one document, edited in the companion app, read on the glasses. It is
// NOT `/solution/*` — that family is the agent's solve loop, an append-only log
// with runs, tokens and a version picker, and your own working shares none of
// it. Editing is `PUT /doc/my-solution` like every other document here.

const mineSource = docSource("my-solution");
const mineTiles = createTileCache(mineSource);
const mineMenuTiles = createTileCache(mineSource, { reserved: [HUD_MENU] });

app.get("/mine/markdown", async (c) => c.json(await mineSource.read()));

app.get("/mine/tiles", async (c) => {
  try {
    const menu = c.req.query("overlay") === "menu";
    const tiles = await (menu ? mineMenuTiles : mineTiles)();
    return c.json({ ...tiles, overlay: menu ? "menu" : null });
  } catch (err) {
    console.error("render mine tiles failed:", err);
    return c.json({ error: "tiles_unavailable" }, 502);
  }
});

app.get("/mine/events", (c) => documentStream(mineSource)(c));

// ── publishing a photo as the assignment ────────────────────────────────────
//
// The body IS the image. Not multipart: every caller here is code (the
// companion app's file picker, the phone's gallery bridge) rather than an HTML
// form, and a raw body keeps the megabytes off a parser and out of a second
// copy in memory.

/** Refuse before spending a Gemini call and two minutes on it. */
const MAX_PHOTO_BYTES = Number(process.env.MAX_PHOTO_BYTES ?? 12_000_000);

app.post("/assignment/photo", async (c) => {
  if (!assignmentConfigured()) {
    return c.json({ ok: false, detail: "no reader configured (set ASSIGNMENT_URL)" }, 503);
  }

  const mime = (c.req.header("content-type") ?? "").split(";")[0]!.trim();
  if (!PHOTO_TYPES.includes(mime as (typeof PHOTO_TYPES)[number])) {
    return c.json(
      { ok: false, detail: `send the image as the body, as one of: ${PHOTO_TYPES.join(", ")}` },
      415,
    );
  }

  const photo = Buffer.from(await c.req.arrayBuffer());
  if (photo.length === 0) return c.json({ ok: false, detail: "empty body" }, 400);
  if (photo.length > MAX_PHOTO_BYTES) {
    return c.json(
      {
        ok: false,
        detail: `photo is ${(photo.length / 1e6).toFixed(1)}MB, limit is ${MAX_PHOTO_BYTES / 1e6}MB`,
      },
      413,
    );
  }

  const result = await publishPhoto(photo, mime, {
    // Default FALSE: photos accumulate into the assignment the way camera
    // frames do, because several photos of one sheet is how a sheet too big to
    // frame gets read. `?reset=1` is "this is a different sheet, start over".
    reset: c.req.query("reset") === "1",
    name: c.req.query("name") ?? c.req.header("x-photo-name") ?? null,
    note: c.req.query("note") ?? undefined,
  });
  return c.json(result, result.ok ? 200 : 502);
});

/** The photo the assignment was last read from — for showing what you sent. */
app.get("/assignment/photo", (c) => {
  const photo = getPublishedPhoto();
  if (!photo) return c.json({ error: "no photo published this run" }, 404);
  return new Response(new Uint8Array(photo.bytes), {
    headers: {
      "content-type": photo.mime,
      "content-length": String(photo.bytes.length),
      "cache-control": "no-store",
    },
  });
});

/** The same thing as metadata, so a poll doesn't drag the bytes with it. */
app.get("/assignment/photo/meta", (c) => {
  const photo = getPublishedPhoto();
  if (!photo) return c.json({ published: false });
  return c.json({
    published: true,
    at: photo.at,
    mime: photo.mime,
    bytes: photo.bytes.length,
    name: photo.name,
  });
});

// ── messages ────────────────────────────────────────────────────────────────
//
// GATING IS ASYMMETRIC, ON PURPOSE, and it is the same split as /solution/*:
//
//   POST /messages         gated by MESSAGE_TOKEN. The camera web app is behind
//                          a password and this server is not, so an open send
//                          endpoint would be a push-text-to-my-HUD service on
//                          the public internet. cam.aansl.com holds the token
//                          and proxies; nothing else should send.
//   everything else        open, because the glasses hold no secret (they ship
//                          to a device — see the note above /solution/*). The
//                          cost is that a stranger who finds the host could
//                          post a fake "Yes" into the log. Accepted: it is the
//                          same exposure /solve already carries, and the
//                          alternative is a credential in a packed app.

const MESSAGE_TOKEN = process.env.MESSAGE_TOKEN ?? "";

app.post("/messages", async (c) => {
  if (MESSAGE_TOKEN && c.req.header("x-message-token") !== MESSAGE_TOKEN) {
    console.log(`[messages] rejected send (${c.req.header("x-forwarded-for") ?? "direct"})`);
    return c.json({ ok: false, reason: "unauthorized" }, 401);
  }
  const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
  const check = normalise(body.text);
  if (!check.ok) return c.json({ ok: false, reason: check.reason }, 400);

  const row = send(check.body, "out");
  return c.json({ ok: true, message: row, folded: check.folded });
});

/** A quick reply, tapped on the glasses. Constrained to the canned set. */
app.post("/messages/reply", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
  if (typeof body.text !== "string" || !QUICK_REPLIES.includes(body.text as never)) {
    return c.json(
      { ok: false, reason: `reply must be one of: ${QUICK_REPLIES.join(", ")}` },
      400,
    );
  }
  return c.json({ ok: true, message: send(body.text, "in") });
});

/** The glasses confirming they drew everything up to `id`. */
app.post("/messages/seen", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { id?: unknown };
  const id = Number(body.id);
  if (!Number.isFinite(id) || id <= 0) {
    return c.json({ ok: false, reason: "id must be a positive integer" }, 400);
  }
  return c.json({ ok: true, marked: markSeen(id) });
});

app.get("/messages", (c) => {
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
  return c.json({ messages: recentMessages(limit), status: getMessageStatus() });
});

app.get("/messages/status", (c) => c.json(getMessageStatus()));

/**
 * The app-lifetime stream.
 *
 * Every other stream in this server belongs to a page and dies when you walk
 * off it (see docPage.ts). This one is opened once at startup and outlives
 * navigation, because a message has to reach you on whichever page you are
 * standing on — that is the entire point of the banner.
 *
 * Emits `messages` with the recent log plus status, on connect and on every
 * change. One payload rather than a delta: the log is 50 short rows, the
 * glasses redraw the whole page anyway, and a delta protocol would be a second
 * thing to keep in sync for no bytes worth saving.
 */
app.get("/messages/events", (c) =>
  streamSSE(c, async (stream) => {
    let closed = false;
    stream.onAbort(() => {
      closed = true;
    });

    messageStreamOpened();

    let chain: Promise<void> = Promise.resolve();
    const write = (event: string, data: string): Promise<void> => {
      chain = chain
        .then(async () => {
          if (closed) return;
          await stream.writeSSE({ event, data });
        })
        .catch(() => {
          closed = true;
        });
      return chain;
    };

    const sendLog = async () => {
      try {
        await write(
          "messages",
          JSON.stringify({ messages: recentMessages(50), status: getMessageStatus() }),
        );
      } catch (err) {
        console.error("[messages] SSE write failed:", err);
      }
    };

    const unsubscribe = subscribeMessages(() => void sendLog());
    await sendLog();

    try {
      while (!closed) {
        await write("ping", "");
        await stream.sleep(HEARTBEAT_MS);
      }
    } finally {
      unsubscribe();
      messageStreamClosed();
    }
  }),
);

startUpstream();

console.log(`Document server on http://localhost:${PORT}`);
console.log(`Watching ${MARKDOWN_PATH}`);
console.log(
  assignmentConfigured()
    ? `Assignment reader at ${process.env.ASSIGNMENT_URL}`
    : "Assignment reader disabled (set ASSIGNMENT_URL to enable)",
);
console.log(`Solutions in ${DB_PATH}`);
console.log(
  `Solve trigger: ${triggerDescription()}${
    solverTokenRequired() ? "" : "  (SOLVER_TOKEN unset — /solution/claim is open)"
  }`,
);
console.log(`Backup solver: ${backupDescription()}`);
console.log(`Reviewer: ${reviewDescription()}`);
console.log(
  MESSAGE_TOKEN
    ? "Messages: POST /messages requires MESSAGE_TOKEN"
    : "Messages: MESSAGE_TOKEN unset — POST /messages is OPEN to anyone who can reach this host",
);

export default {
  port: PORT,
  // Not optional: at Bun's default of 10s this server disconnects its own
  // event streams. See the note at HEARTBEAT_MS.
  idleTimeout: IDLE_TIMEOUT_S,
  fetch: app.fetch,
};
