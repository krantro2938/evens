// Document server for the Even Realities glasses app.
//
// Serves two documents through one markdown → PNG tile pipeline, so the glasses
// client stays thin (no marked/MathJax/html2canvas on-device):
//
//   solution.md (repo root, watched)     assignment (lookcam reader, live)
//   GET /markdown                        GET  /assignment/markdown
//   GET /tiles                           GET  /assignment/tiles
//   GET /events                          GET  /assignment/events
//                                        GET  /assignment/status
//                                        POST /assignment/toggle
//
// `version` is what the client refetches on: the file mtime for solution.md, a
// content hash for the assignment (whose own `version` field only bumps on
// /reset, so it would never signal an individual capture's edits).
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
  assignmentSource,
  getStatus,
  isConfigured as assignmentConfigured,
  startUpstream,
  subscribeStatus,
  toggle,
} from "./assignment";

const __dirname = dirname(fileURLToPath(import.meta.url));
// solution.md lives in the repo root, one level up from server/.
const MARKDOWN_PATH = resolve(__dirname, "..", "solution.md");
const PORT = Number(process.env.PORT ?? 8787);
const HEARTBEAT_MS = 15_000;

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

const getFileTiles = createTileCache(fileSource);
const getAssignmentTiles = createTileCache(assignmentSource);

// ── routes ──────────────────────────────────────────────────────────────────

const app = new Hono();

// The app is served from the Vite dev origin (a different port), so allow CORS.
app.use("*", cors());

/**
 * SSE for one document. Emits `markdown` with `{ content, version }` on connect
 * and on every change; `ping` heartbeats keep proxies from timing the stream
 * out. With `withStatus`, also emits `status` — job state and the model's
 * camera advice, which change far more often than the document does.
 */
function documentStream(source: DocSource, withStatus = false) {
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
      const sendStatus = () => write("status", JSON.stringify(getStatus()));

      const unsubscribeDoc = source.subscribe(() => void sendDoc());
      const unsubscribeStatus = withStatus
        ? subscribeStatus(() => void sendStatus())
        : null;

      // Push the current state immediately so a fresh subscriber is in sync.
      // Status first: if the document is unavailable (reader down, nothing
      // captured yet) the client still learns why.
      if (withStatus) await sendStatus();
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

app.get("/markdown", async (c) => {
  try {
    return c.json(await readFileSnapshot());
  } catch (err) {
    console.error("read solution.md failed:", err);
    return c.json({ error: "markdown_unavailable" }, 500);
  }
});

app.get("/tiles", async (c) => {
  try {
    return c.json(await getFileTiles());
  } catch (err) {
    console.error("render tiles failed:", err);
    return c.json({ error: "tiles_unavailable" }, 500);
  }
});

app.get("/events", documentStream(fileSource));

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
    return c.json(await assignmentSource.read());
  } catch (err) {
    console.error("read assignment failed:", err);
    return c.json({ error: "assignment_unavailable" }, 502);
  }
});

app.get("/assignment/tiles", async (c) => {
  try {
    return c.json(await getAssignmentTiles());
  } catch (err) {
    console.error("render assignment tiles failed:", err);
    return c.json({ error: "tiles_unavailable" }, 502);
  }
});

app.get("/assignment/status", (c) => c.json(getStatus()));

app.get("/assignment/events", documentStream(assignmentSource, true));

app.post("/assignment/toggle", async (c) => {
  const result = await toggle();
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

export default {
  port: PORT,
  fetch: app.fetch,
};
