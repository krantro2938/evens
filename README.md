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

**The solver is `routine/runner.sh` for now, not the cloud routine.** A tap always
records the run server-side; what picks it up is deliberately separate. The cloud
routine can't, because an Anthropic cloud session's egress proxy refuses
`CONNECT even.aansl.com:443` — so run the runner on a machine with a logged-in
`claude` CLI:

```bash
SOLVER_TOKEN=<same as .env> ./routine/runner.sh --watch
```

Tap with no runner up and the run simply waits; the glasses say `QUEUED` rather
than pretending. See [`routine/solve.md`](routine/solve.md) for the routine, why
it's disabled, and what re-enabling it needs.

The glasses app talks to **one origin only**: the document server. Everything
upstream of it — the reader, the camera stack, the API keys — is the document
server's business, and is configured there rather than in the app.

## Where every variable lives

Each service owns one file. Nothing is configured in two places.

| File | Owns | Key settings |
|---|---|---|
| `test/.env.local` | the glasses app | `VITE_MD_TARGET` (dev proxy), `VITE_MD_SERVER` (packed build) |
| `.env` (this repo, next to `docker-compose.yml`) | the document server's deployment | `ASSIGNMENT_URL`, `ASSIGNMENT_TOKEN`, `ASSIGNMENT_DEBOUNCE_MS`, `SOLVER_TOKEN`, `CLAUDE_TRIGGER_ID` |
| the routine, at [claude.ai/code/routines](https://claude.ai/code/routines) | the solving agent | its prompt (a copy lives in `routine/solve.md`), its model, and `SOLVER_TOKEN` again |
| `vps/docker/.env` in the lookcam repo | the camera stack and the reader | `GEMINI_API_KEY`, `ASSIGNMENT_TOKEN`, `SNAPSHOT_TOKEN`, `DOMAIN`, `ASSIGNMENT_DOMAIN`, `EVENS_DOMAIN` |

Two values have to match across files, and both fail quietly if they don't:

- `ASSIGNMENT_TOKEN` — this repo's `.env` and the lookcam stack's. If the
  assignment page is empty and `/assignment/status` reports an error, check that
  first.
- `SOLVER_TOKEN` — this repo's `.env` and the routine's prompt. If a tap says
  "solving" and nothing ever arrives, the routine is being answered `401` at
  `/solution/claim`.

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
