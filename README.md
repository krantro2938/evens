# evens

An Even Realities G2 app that shows live documents on the glasses, and the
server that renders them.

- **`test/`** — the glasses app (Vite + TypeScript + Even Hub SDK).
- **`server/`** — the document server: watches `solution.md`, bridges the
  [lookcam assignment reader](https://github.com/krantro2938/math-server-capture),
  runs the solve loop, and pre-renders every document into PNG tiles so the
  glasses stay thin.
- **`routine/solve.md`** — the prompt the Claude routine runs when you tap
  "solve" on the glasses.
- **`solution.md`** — the fallback for the AI page, until a solve has landed.

## How the pieces connect

```
 camera ─▶ MediaMTX ─▶ web gateway ─▶ assignment reader ─┐
                                       (Gemini)          │  SSE
                                                         ▼
 solution.md ──────────── watched ──────────▶ document server ──▶ glasses app
                                              (renders tiles)      (this repo)
                                                    │  ▲
                                    trigger on tap   │  │  markdown back
                                                     ▼  │
                                              Claude routine
                                              (cloud session)
```

The AI page shows whatever was last solved. When there is no solution for the
paper currently under the camera, it shows a trigger button instead: a tap hands
the transcription to a solver and the answer arrives on the glasses when it's
done. Every solution is kept in SQLite, so nothing is lost across restarts — see
[`server/README.md`](server/README.md#the-solve-loop).

A solution can include **figures** as well as prose and LaTeX — a graph, a
geometry diagram, vectors, a solution set on a number line. The solver writes a
```` ```viz ```` block holding the data; the server draws it, sizes it for the
panel, and makes sure a page boundary never lands in the middle of it. See
[figures](server/README.md#figures).

A tap always records the run server-side; **what picks it up is deliberately
separate**, and there are two solvers:

- the **routine** — a cloud session fired by the tap through its API trigger.
  It needs a repository selected and its environment's network access opened to
  this server's domain, or a fire returns 200 and nothing happens. See
  [`routine/solve.md`](routine/solve.md).
- **`routine/runner.sh`** — the same protocol from a machine with a logged-in
  `claude` CLI. The fallback, and the thing to run when a run is stuck queued:

  ```bash
  SOLVER_TOKEN=<same as .env> ./routine/runner.sh --watch
  ```

Tap with neither available and the run simply waits; the glasses say `QUEUED`
rather than pretending.

The glasses app talks to **one origin only**: the document server. Everything
upstream of it — the reader, the camera stack, the API keys — is the document
server's business, and is configured there rather than in the app.

## Where every variable lives

Each service owns one file. Nothing is configured in two places.

| File | Owns | Key settings |
|---|---|---|
| `test/.env.local` | the glasses app | `VITE_MD_TARGET` (dev proxy), `VITE_MD_SERVER` (packed build) |
| `.env` (this repo, next to `docker-compose.yml`) | the document server's deployment | `ASSIGNMENT_URL`, `ASSIGNMENT_TOKEN`, `ASSIGNMENT_DEBOUNCE_MS`, `SOLVER_TOKEN`, `MESSAGE_TOKEN`, `ROUTINE_ID`, `ROUTINE_TOKEN` |
| the routine, at [claude.ai/code/routines](https://claude.ai/code/routines) | the solving agent | its prompt (a copy lives in `routine/solve.md`), its model, its **network allowlist**, and `SOLVER_TOKEN` again |
| `vps/docker/.env` in the lookcam repo | the camera stack and the reader | `GEMINI_API_KEY`, `ASSIGNMENT_TOKEN`, `SNAPSHOT_TOKEN`, `MESSAGE_TOKEN`, `DOMAIN`, `ASSIGNMENT_DOMAIN`, `EVENS_DOMAIN` |

Three values have to match across files, and all three fail quietly if they don't:

- `ASSIGNMENT_TOKEN` — this repo's `.env` and the lookcam stack's. If the
  assignment page is empty and `/assignment/status` reports an error, check that
  first.
- `SOLVER_TOKEN` — this repo's `.env` and the routine's prompt. If a tap says
  "solving" and nothing ever arrives, the routine is being answered `401` at
  `/solution/claim`.
- `MESSAGE_TOKEN` — this repo's `.env` and the lookcam stack's. If the chat
  widget on `cam.aansl.com` says "unauthorized" on send, this is why.

## Messages

A chat widget in the bottom-right of `cam.aansl.com`, and a `Msgs` tile on the
glasses. Text goes one way, canned replies come back — there is no keyboard on
the glasses, so "chat" here means a log you write to from one end.

- **240 characters**, ASCII only. Both are the panel's limits, not a policy: the
  font has no glyph outside ASCII and silently draws *nothing* for what it
  lacks, so the widget names the offending characters instead of sending a
  sentence with holes in it. Curly quotes, dashes and ellipses are folded rather
  than refused — a paste shouldn't be an error.
- **An arriving message takes the screen for 7–15 seconds** (scaled by length),
  then hands it back to whatever you were doing. Tap to reply, double-tap to
  dismiss. It does *not* interrupt the Camera page — messages wait until you
  leave it, rather than stealing a tap mid-scan.
- **The unread count on the `Msgs` tile is the only notification indicator.** No
  document page reserves pixels for one: all four image containers hold the
  document, and text containers are transparent, so a permanent badge would mean
  a permanent hole in every rendered page (the problem `HUD_FEEDBACK` solves by
  baking a box into the tiles).
- **Only the send route is gated.** `MESSAGE_TOKEN` is held by the camera web
  app alone, so being logged in there is the only way to write to the glasses.
  Reply and ack are open, because a packed app cannot hold a secret — the same
  trade `/solve` already makes.

Templates: `.env.example` in this directory and in `test/`.

## Deployed

| Host | Serves |
|---|---|
| `even.aansl.com` | this document server — what the glasses point at |
| `assignment.aansl.com` | the reader's API; used by this server, not by the glasses |
| `cam.aansl.com` | the camera gateway and its web UI |

## Run it

Against the deployed server, with nothing running locally:

```bash
cd test && npm install && npm run dev && npm run simulate
```

Everything local — see `server/README.md` for the server's own prerequisites
(bun, and Chromium via `bunx playwright install chromium`):

```bash
cd server && bun install && bun run start   # terminal 1
cd test && npm run dev:local                # terminal 2
```

Deploying the server (joins the lookcam stack's network so Caddy can front it
and it can reach the reader over the docker bridge):

```bash
cp .env.example .env && nano .env    # ASSIGNMENT_TOKEN must match the lookcam stack
docker compose up -d --build
```
