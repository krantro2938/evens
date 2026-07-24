// Markdown server for the Even Realities glasses AI page.
//
// Serves the repo-root `solution.md` and pushes live updates so the glasses
// app can re-render on save:
//   GET /markdown  -> { content, version }   (initial load + 10s poll fallback)
//   GET /events    -> SSE, emits { version, content } whenever the file changes
//
// `version` is the file mtime in ms; the client re-renders when it changes.
// Run with: bun run index.ts   (or `bun run dev` to auto-restart on edits)

import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// solution.md lives in the repo root, one level up from server/.
const MARKDOWN_PATH = resolve(__dirname, "..", "solution.md");
const PORT = Number(process.env.PORT ?? 8787);
const HEARTBEAT_MS = 15_000;

interface Snapshot {
  content: string;
  version: number;
}

async function readSnapshot(): Promise<Snapshot> {
  const [content, info] = await Promise.all([
    readFile(MARKDOWN_PATH, "utf8"),
    stat(MARKDOWN_PATH),
  ]);
  return { content, version: Math.floor(info.mtimeMs) };
}

// Fan out file-change notifications to all connected SSE clients.
const listeners = new Set<() => void>();

// fs.watch can emit several events per save (and occasionally rename events on
// atomic writes); debounce so clients see one update per logical change.
let debounce: ReturnType<typeof setTimeout> | null = null;
watch(MARKDOWN_PATH, () => {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    for (const notify of listeners) notify();
  }, 100);
});

const app = new Hono();

// The app is served from the Vite dev origin (a different port), so allow CORS.
app.use("*", cors());

app.get("/markdown", async (c) => {
  try {
    const snap = await readSnapshot();
    return c.json(snap);
  } catch (err) {
    console.error("read solution.md failed:", err);
    return c.json({ error: "markdown_unavailable" }, 500);
  }
});

app.get("/events", (c) => {
  return streamSSE(c, async (stream) => {
    let closed = false;
    stream.onAbort(() => {
      closed = true;
    });

    const send = async () => {
      if (closed) return;
      try {
        const snap = await readSnapshot();
        await stream.writeSSE({
          event: "markdown",
          data: JSON.stringify(snap),
        });
      } catch (err) {
        console.error("SSE read failed:", err);
      }
    };

    const onChange = () => {
      void send();
    };
    listeners.add(onChange);

    // Push the current state immediately so a fresh subscriber is in sync.
    await send();

    try {
      while (!closed) {
        // Comment heartbeat keeps proxies / the EventSource from timing out.
        await stream.writeSSE({ data: "", event: "ping" });
        await stream.sleep(HEARTBEAT_MS);
      }
    } finally {
      listeners.delete(onChange);
    }
  });
});

console.log(`Markdown server on http://localhost:${PORT}`);
console.log(`Watching ${MARKDOWN_PATH}`);

export default {
  port: PORT,
  fetch: app.fetch,
};
