# Document server

Serves documents to the Even Realities glasses app and **pre-renders them into
PNG tiles** (headless Chromium + sharp) so the glasses client stays thin — no
marked/MathJax/html2canvas on-device. Pushes live updates so the glasses
re-fetch when the document changes.

Four documents, one pipeline:

| Document | Source | Glasses page |
|---|---|---|
| the AI document | whatever Claude last solved (SQLite), falling back to `solution.md` in the repo root, watched with `fs.watch` | AI |
| the assignment | the [lookcam assignment reader](../../lookcam/assignment), over SSE | Assignment |
| Adri | markdown you type in the camera web app (SQLite, one row) | Adri |
| my solution | your own answer to the scan, typed in the companion app (SQLite, one row) | Mine |

It also owns the **solve loop**: the AI page's trigger button hands the
transcribed assignment to a Claude routine and displays the markdown that comes
back. See [the solve loop](#the-solve-loop) below.

## Run

```bash
bun install
bunx playwright install chromium   # one-time: fetch the headless browser
bun run start                      # or: bun run dev  (auto-restart on edits)
```

Default port `8787` (override with `PORT`).

## Endpoints

### the AI document

| Route | Purpose |
|---|---|
| `GET /markdown[?solution_id=ID]` | `{ content, version }` for the newest solution, or `solution.md` until there is one. Pass a solution ID to open history. |
| `GET /tiles[?solution_id=ID]` | `{ version, pages: [{ tiles: [{ index, data }] }] }` — server-rendered PNG tiles for the selected solution, cached per solution and `version`. |
| `GET /events[?solution_id=ID]` | SSE. Emits `event: markdown` for the selected solution, `event: status` with solve state and recent solution metadata, and `event: ping` heartbeats. |
| `GET /solution/status` | the `status` payload on demand (poll fallback) |
| `POST /solution/solve` | the trigger button: mint a run and start the routine → `{ ok, action: "triggered"\|"queued", run_id, detail? }` |
| `POST /solution/cancel` | abandon the live run → `{ ok, action: "cancelled", run_id }` |

**Your own answer is not here.** It used to be — a `solutions` row with
`source='me'` — and since this page shows the newest row whoever wrote it,
writing down your own working hid Claude's. It is a hand-written document now
(`my-solution`, below), on its own glasses page.

### hand-written documents (the Adri and Mine pages)

Markdown you type yourself rather than derive from a camera or an agent. **One
row per slug** — saving replaces it, there is no history, and the version is a
content hash, so saving the same text twice costs no render and no BLE push
while an edit pushes new tiles to the glasses on its own.

Slugs are a fixed list (`adri-assignment`, `adri-solution`, `my-solution`):
every one is a page on the glasses and a tab in an app, both built at compile
time, so an open endpoint would let a typo create a document nothing can ever
show.

`my-solution` is deliberately a document and not a `solutions` row: it is one
answer you keep editing, not an attempt log, and rows in that table are what the
AI page displays.

| Route | Purpose |
|---|---|
| `GET /doc/:slug` | `{ slug, markdown, saved, version, updated_at }`. `saved:false` distinguishes "never written" from "written empty" |
| `PUT /doc/:slug` | `{"markdown"}` — replaces it → `{ ok, version, updated_at }`. An empty body clears it, and the placeholder comes back |
| `GET /adri/markdown` | the `adri-solution` document, as the glasses read it |
| `GET /adri/tiles[?overlay=menu]` | same tile shape as `/tiles` |
| `GET /adri/events` | SSE — `event: markdown` when it is edited |
| `GET /mine/markdown` | the `my-solution` document, as the glasses read it |
| `GET /mine/tiles[?overlay=menu]` | same tile shape as `/tiles` |
| `GET /mine/events` | SSE — `event: markdown` when it is edited |

### assignment

Enabled by setting `ASSIGNMENT_URL`. Without it every route below answers
`503 assignment_not_configured` and `solution.md` is unaffected.

| Route | Purpose |
|---|---|
| `GET /assignment/markdown` | `{ content, version }` — the reader's `/assignment.md`, `version` is a content hash |
| `GET /assignment/tiles` | same shape as `/tiles` |
| `GET /assignment/events` | SSE. `event: markdown` when the transcription changes, `event: status` on job/camera-advice changes, `event: ping` heartbeats |
| `GET /assignment/status` | the `status` payload on demand (poll fallback) |
| `GET /assignment/camera[?size=4\|1&rotate=0\|90\|180\|270&mode=ink\|photo&overlay=menu]` | **the live camera as tiles** — `{ tiles, size, rotate, mode, contrast, at }`, same tile shape as `/tiles`. Costs a frame grab, never a Gemini call. Renders are coalesced for `CAMERA_PREVIEW_TTL_MS`, so several viewers (and a poll that overlaps the last one) share one grab. |
| `POST /assignment/toggle` | start / stop / reset+start, chosen from live job state → `{ ok, action, detail? }` |
| `POST /assignment/control` | `{"action":"start\|stop\|reset\|restart\|extend\|toggle"}` — the same, named outright → `{ ok, action, detail? }` |
| `POST /assignment/photo[?reset=0&name=]` | **publish a photo as the assignment** — the body IS the image (`image/jpeg\|png\|webp\|heic\|heif`). Forwards to the reader, which archives the current attempt and reads this photo as a new one. `?reset=0` merges into the current attempt instead → `{ ok, version, problems, done }` |
| `GET /assignment/photo` | the photo last published, as bytes — for showing what you sent |
| `GET /assignment/photo/meta` | the same as metadata, so a poll doesn't drag the bytes with it |

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

### the solve loop's own routes

These are the Claude routine's side of the conversation, not the glasses'. They
are gated by `SOLVER_TOKEN` (header `x-solver-token`, `Authorization: Bearer`, or
`?token=`) because between them they hand out the assignment and decide what gets
displayed.

| Route | Purpose |
|---|---|
| `GET /solution/claim` | The agent's first call: takes the oldest queued run and returns the assignment text **plus a one-time `run_token`**. `{"ok":false,"reason":"no_pending_run"}` with status 200 when the queue is empty, so a cron run that finds nothing exits cleanly. |
| `POST /solution/submit` | `{ markdown, model?, notes? }` with the run token → stores it, ends the run, pushes new tiles. `409 unknown_or_superseded_token` if the run is no longer the current one. |
| `POST /solution/fail` | `{ error }` with the run token → the reason shows on the glasses instead of a timeout. |

### Configuration

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8787` | |
| `ASSIGNMENT_URL` | — | e.g. `http://<vps-ip>:8091`. Empty disables the assignment routes. |
| `ASSIGNMENT_TOKEN` | — | the reader's `API_TOKEN` |
| `ASSIGNMENT_DEBOUNCE_MS` | `2000` | how long to coalesce reader events before re-rendering |
| `CAMERA_SNAPSHOT_URL` | `$ASSIGNMENT_URL/snapshot.jpg` | where preview frames come from. The reader owns the gateway URL, its token and the RTSP fallback, so by default this needs nothing — point it elsewhere only if this server can reach the camera stack but the reader can't be used |
| `CAMERA_SNAPSHOT_TOKEN` | — | only for a `CAMERA_SNAPSHOT_URL` aimed at the web gateway, which gates on its own `SNAPSHOT_TOKEN` rather than the reader's |
| `CAMERA_PREVIEW_TTL_MS` | `700` | how long a rendered preview frame is reused |
| `MAX_PHOTO_BYTES` | `12000000` | a published photo bigger than this is refused before it costs a model call |
| `PHOTO_TIMEOUT_MS` | `120000` | how long to wait for the reader to transcribe a published photo |
| `DATA_DIR` | `../data` | `solver.sqlite` (runs + every solution), and the OAuth copy |
| `SOLVER_TOKEN` | — | the routine's shared secret. **Empty leaves `/solution/claim` open** — fine locally, not on a public vhost. |
| `ROUTINE_ID` | — | the routine a tap fires. Empty: runs are queued for the runner instead. |
| `ROUTINE_TOKEN` | — | that routine's API-trigger token (`sk-ant-oat01-…`), shown once when generated |
| `SOLVE_TIMEOUT_MS` | `1200000` | a claimed run that never submits fails after this |
| `SOLVE_QUEUE_TIMEOUT_MS` | `10800000` | a queued run nobody claims fails after this |
| `SOLVE_MAX_CHARS` | `200000` | submissions larger than this are refused, not rendered |
| `DOC_MAX_CHARS` | `200000` | the same ceiling for a hand-written document |

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

### The camera preview's two modes

`mode=ink` (the default) subtracts each frame's own local background and keeps
what is **darker** than its surroundings — text, rules, the edge of the sheet —
drawn bright on black, the way the document tiles are drawn. `mode=photo` is the
equalised greyscale photograph it replaced.

The reason is the panel. A greyscale photo of a sheet of paper is mostly light
pixels, and on an emissive display that means most of the panel is lit: a wall
of green with the detail buried in it, worst exactly when the frame is blank or
badly exposed. Ink spends the panel only on marks, which also makes it about a
third the bytes (~4KB for a full panel against ~13KB).

`contrast` in the response is how much ink the frame actually had, 0–255, before
it was scaled up. Below ~16 the server stops amplifying — otherwise a frame with
nothing in it has its own sensor noise stretched into a convincing field of text
— so the panel goes black and this number is what says why. It is `null` in
photo mode, which never renders black and so has nothing to disambiguate.

## The solve loop

A tap on the AI page's trigger button asks a **Claude routine** — a cloud Claude
Code session, see [`../routine/solve.md`](../routine/solve.md) — to solve the
assignment currently on the paper and post it back as markdown.

```
 glasses ──▶ POST /solution/solve
               mints run + one-time token, snapshots the assignment,
               then POSTs /v1/code/triggers/<id>/run
                                                    │
 routine ◀──────────────────────────────────────────┘
    ├──▶ GET  /solution/claim    the assignment text + that token
    └──▶ POST /solution/submit   the finished markdown
                    │
                    └─▶ SQLite ─▶ tiles ─▶ BLE push ─▶ the AI page
```

**The token is the whole concurrency story.** It is minted per run, and creating a
run supersedes every earlier one in the same transaction. So if you tap again —
the first attempt is slow, or the camera has moved on — the older agent's token
stops being accepted and its answer is refused on arrival. Exactly one answer can
land, and it is always the answer to the request you made last. That is why the
agent fetches the token at claim time rather than being handed one up front.

The assignment is **snapshotted into the run row**, not refetched at claim time:
the agent must solve the paper you were looking at when you tapped, even if the
camera has since drifted onto something else.

Nothing is ever deleted. A re-solve inserts a row and the newest wins, so a bad
solve can't destroy the good one you had, and a solution stays readable after the
paper (and so the assignment) has changed — the page labels it as answering an
earlier scan and offers to solve the current one.

### Who drains the queue

Either of two solvers, and the server doesn't care which:

- **the routine** — fired on the tap itself, via its API trigger (below).
- **[`routine/runner.sh`](../routine/runner.sh)** — the same three endpoints from
  a machine with a logged-in `claude` CLI. The fallback when the routine isn't
  configured, and what to reach for when a run is stuck in the queue:

  ```bash
  SOLVER_TOKEN=… ./routine/runner.sh --watch    # keep draining
  SOLVER_TOKEN=… ./routine/runner.sh            # drain once
  ```

That the transport can be swapped at all is the point of separating "record the
run" from "start the agent": it was swapped once already, under a live design,
without the server or the glasses changing a line.

### Triggering

`POST /v1/claude_code/routines/<ROUTINE_ID>/fire` with the routine's own bearer
token (`ROUTINE_TOKEN`, generated in the API-trigger modal at
[claude.ai/code/routines](https://claude.ai/code/routines)) and the
`experimental-cc-routine-2026-04-01` beta header. The token only fires that one
routine, which is why it can live in a `.env` here.

Two ways for a fire to return 200 and still do nothing, both configuration rather
than code:

- **the routine has no repository.** Then no session is created at all — the
  give-away is a response with no `claude_code_session_url`.
- **the environment can't reach this server.** Cloud environments default to
  *Trusted* network access, which blocks every domain outside the package
  registries; the routine's `/solution/claim` then dies at the egress proxy with
  `403 host_not_allowed`. Set the environment's Network access to **Custom** and
  add this server's domain.

Every failure path **leaves the run queued rather than losing it**: no routine
configured, a revoked token, an API error — the run sits in `pending` for the
runner or the routine's schedule to pick up. A broken trigger degrades from
"seconds" to "when something else looks", not to "the button does nothing", and
`status.run.trigger` says which you got so the glasses can tell you. On success
`trigger_detail` is the session URL, which is where a run explains itself.

### `/solution/status`

```jsonc
{
  "state": "idle",             // no_assignment|idle|queued|solving|solved|failed
  "assignment": { "available": true, "version": 3346044740,
                  "problems": 3, "done": true },
  "solution": { "created_at": 1785081935258, "age_ms": 41000,
                "model": "claude-sonnet-5", "assignment_version": 3346044740,
                "stale": false,        // true: it answers an EARLIER scan
                "chars": 2480 },
  "run": { "id": 5, "state": "pending", "age_ms": 1200, "claimed": false,
           "trigger": "triggered",     // triggered|unconfigured|failed
           "trigger_detail": "trig_…", "error": null },
  "trigger": { "configured": true, "detail": "trig_…" },
  "solutions": 4                       // how many are on disk
}
```

`idle` is what puts the button on the glasses: there is something to solve and no
solution for *this* version of it. `stale` is why a new sheet of paper brings the
button back without you having to clear anything.

## Controls

The reader's endpoints are individually simple, but their preconditions are not,
which is why both control routes live here rather than in the glasses app:

- `/start` answers `409` while a job runs **and** once the assignment is
  complete (that one wants `/reset` first).
- After a `max_captures` stop, `/start` answers `202` and then does *nothing* —
  the ceiling counts captures per version, so the job re-finishes on its first
  loop check. `extend` is the fix: it restarts with `max_captures` raised to
  `captures + 20`.
- A rescan is `/reset` then `/start`, and `/reset` archives first, so scrapping
  an attempt can't destroy a transcription you wanted.

`/toggle` picks one of these from live job state — it's what a tap on the
glasses sends. `/control` names the action instead, for the double-tap menu
where the user has already chosen. `toggle` is just `control(defaultAction())`.

## Quick check

```bash
curl localhost:8787/markdown
curl -s localhost:8787/tiles | head -c 200        # first render takes ~1–2s
curl -N localhost:8787/events                     # then edit + save solution.md

curl -s localhost:8787/assignment/status | jq
curl -N localhost:8787/assignment/events &        # watch
curl -s -X POST localhost:8787/assignment/toggle  # {"ok":true,"action":"started"}

curl -s -X POST localhost:8787/assignment/control \
  -H 'content-type: application/json' -d '{"action":"restart"}'   # rescan from scratch
```

Playing the routine's part by hand — the fastest way to see the whole loop work
without waiting on a cloud session:

```bash
T=your-solver-token
curl -s localhost:8787/solution/status | jq '.state'      # "idle" → the button shows
curl -s -X POST localhost:8787/solution/solve | jq        # {"action":"triggered"|"queued"}

RUN=$(curl -s -H "x-solver-token: $T" localhost:8787/solution/claim)
echo "$RUN" | jq -r '.assignment.markdown'                # what the agent is given
TOKEN=$(echo "$RUN" | jq -r .run_token)

curl -s -X POST localhost:8787/solution/submit -H "x-run-token: $TOKEN" \
  -H 'content-type: application/json' -d '{"markdown":"# Solved\n\n**Answer: 42**"}'
curl -s localhost:8787/markdown | jq -r .content          # the AI page now shows it
```

Claim a run, then `POST /solution/solve` again, then submit with the first token:
`409 unknown_or_superseded_token`. That's the guard that keeps a slow agent from
overwriting a fresh solve.
