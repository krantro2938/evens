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
//
// Both documents take `?overlay=menu` (the same page with the action menu's
// rectangle darkened, so the menu can open without hiding the document) and a
// history selector: `?solution_id=` for the AI page, `?version=` for the
// assignment's earlier scans.
//   GET  /solution/claim   ─┐ the Claude routine's side of the solve loop
//   POST /solution/submit   │ (see solver.ts) — token-gated, not for the glasses
//   POST /solution/fail    ─┘
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
  control,
  getArchive,
  getStatus,
  isConfigured as assignmentConfigured,
  startUpstream,
  subscribeStatus,
  toggle,
  type ControlAction,
} from "./assignment";
import {
  authorizeSolver,
  cancelRun,
  claimRun,
  createAiSource,
  failRun,
  getSolverStatus,
  solverTokenRequired,
  startRun,
  submitSolution,
  subscribeSolver,
} from "./solver";
import { HUD_FEEDBACK, HUD_MENU, type Rect } from "./render/constants";
import { DB_PATH } from "./db";
import { triggerDescription } from "./trigger";

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

app.post("/solution/submit", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const markdown = typeof body.markdown === "string" ? body.markdown : "";
  const result = submitSolution(
    runToken(c, body),
    markdown,
    typeof body.model === "string" ? body.model : null,
    typeof body.notes === "string" ? body.notes : null,
  );
  // 409, not 401: a superseded token is a race the agent lost, not a bad
  // credential — you tapped again while it was working.
  return c.json(result, result.ok ? 200 : 409);
});

app.post("/solution/fail", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = failRun(runToken(c, body), String(body.error ?? ""));
  return c.json(result, result.ok ? 200 : 409);
});

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
    // The advice box is reserved on every render; the menu's box only on the
    // overlay variant, which is what the glasses swap to while it is open.
    const reserved = menu ? [HUD_FEEDBACK, HUD_MENU] : [HUD_FEEDBACK];
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

app.get("/assignment/status", (c) => c.json(getStatus()));

/** The reader's scan history, as the glasses' version picker sees it. */
app.get("/assignment/archive", (c) => c.json({ versions: getArchive() }));

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

// The menu: the glasses name the action outright.
const CONTROL_ACTIONS: ControlAction[] = [
  "start",
  "stop",
  "reset",
  "restart",
  "extend",
  "none",
  "toggle",
];

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

export default {
  port: PORT,
  // Not optional: at Bun's default of 10s this server disconnects its own
  // event streams. See the note at HEARTBEAT_MS.
  idleTimeout: IDLE_TIMEOUT_S,
  fetch: app.fetch,
};
