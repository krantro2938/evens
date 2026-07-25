# Document server

Serves documents to the Even Realities glasses app and **pre-renders them into
PNG tiles** (headless Chromium + sharp) so the glasses client stays thin — no
marked/MathJax/html2canvas on-device. Pushes live updates so the glasses
re-fetch when the document changes.

Two documents, one pipeline:

| Document | Source | Glasses page |
|---|---|---|
| `solution.md` | the repo root, watched with `fs.watch` | AI |
| the assignment | the [lookcam assignment reader](../../lookcam/assignment), over SSE | Assignment |

## Run

```bash
bun install
bunx playwright install chromium   # one-time: fetch the headless browser
bun run start                      # or: bun run dev  (auto-restart on edits)
```

Default port `8787` (override with `PORT`).

## Endpoints

### solution.md

| Route | Purpose |
|---|---|
| `GET /markdown` | `{ content, version }` — `version` is the file mtime (ms). Raw text; used for the client's text fallback and as the poll trigger. |
| `GET /tiles` | `{ version, pages: [{ tiles: [{ index, data }] }] }` — server-rendered PNG tiles (`data` is base64), 2×2 grid of 288×126 per page. Cached per `version`. |
| `GET /events` | SSE. Emits `event: markdown` with `{ version, content }` on connect and whenever `solution.md` changes; `event: ping` heartbeats keep the stream alive. The client refetches `/tiles` when `version` advances. |

### assignment

Enabled by setting `ASSIGNMENT_URL`. Without it every route below answers
`503 assignment_not_configured` and `solution.md` is unaffected.

| Route | Purpose |
|---|---|
| `GET /assignment/markdown` | `{ content, version }` — the reader's `/assignment.md`, `version` is a content hash |
| `GET /assignment/tiles` | same shape as `/tiles` |
| `GET /assignment/events` | SSE. `event: markdown` when the transcription changes, `event: status` on job/camera-advice changes, `event: ping` heartbeats |
| `GET /assignment/status` | the `status` payload on demand (poll fallback) |
| `POST /assignment/toggle` | start / stop / reset+start, chosen from live job state → `{ ok, action, detail? }` |

`status` is:

```jsonc
{
  "upstream": "open",        // our link to the reader: disabled|connecting|open|error
  "running": true,           // a capture job is going
  "done": false,             // the model says it has the whole assignment
  "captures": 3, "max_captures": 40,
  "reason": null,            // why the last job ended: done|stopped|max_captures|failed
  "problems": 2,
  "feedback": {              // last model_response — how to aim the camera
    "camera_advice": "move_down",
    "advice_detail": "The lower third of the sheet is out of frame; tilt down.",
    "cut_off_edges": ["bottom"], "frame_quality": "good", "confidence": 0.6
  },
  "error": null
}
```

### Configuration

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8787` | |
| `ASSIGNMENT_URL` | — | e.g. `http://<vps-ip>:8091`. Empty disables the assignment routes. |
| `ASSIGNMENT_TOKEN` | — | the reader's `API_TOKEN` |
| `ASSIGNMENT_DEBOUNCE_MS` | `2000` | how long to coalesce reader events before re-rendering |

CORS is open so the app (served from the Vite dev origin) can reach it.

## How the assignment bridge works

The reader already emits the assignment as markdown + LaTeX, so it plugs into
the same pipeline as `solution.md` — no new rendering code. `assignment.ts`
holds **one** upstream SSE connection shared by every glasses client (with
reconnect + backoff), and keeps two views of it:

- **the document** — refetched from `/assignment.md` and versioned by content
  hash. Deliberately *not* the reader's own `version` field, which only bumps on
  `/reset` and so would never signal a capture's edits. The hash also means a
  capture that refines nothing textual costs no render and no BLE push.
- **the status** — job state plus the model's camera advice, pushed separately
  because it changes several times per capture while the document often doesn't.

Document refreshes are debounced by `ASSIGNMENT_DEBOUNCE_MS`: a capture lands
every few seconds and a render is ~1–2 s of Chromium plus a four-tile BLE push,
so chasing every event would keep the link permanently saturated.

The reader's token stays here. The glasses never hold it — `EventSource` can't
set headers, so a browser-side client would have to carry it in a query string,
i.e. in the shipped app bundle.

`POST /assignment/toggle` exists because `/start` answers `409` both while a job
runs *and* once the assignment is complete (that one wants `/reset` first).
Deciding here, where the live job state already is, keeps that state machine out
of the glasses app.

## Quick check

```bash
curl localhost:8787/markdown
curl -s localhost:8787/tiles | head -c 200        # first render takes ~1–2s
curl -N localhost:8787/events                     # then edit + save solution.md

curl -s localhost:8787/assignment/status | jq
curl -N localhost:8787/assignment/events &        # watch
curl -s -X POST localhost:8787/assignment/toggle  # {"ok":true,"action":"started"}
```
