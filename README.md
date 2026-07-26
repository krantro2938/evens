# evens

An Even Realities G2 app that shows live documents on the glasses, and the
server that renders them.

- **`test/`** — the glasses app (Vite + TypeScript + Even Hub SDK).
- **`server/`** — the document server: watches `solution.md`, bridges the
  [lookcam assignment reader](https://github.com/krantro2938/math-server-capture),
  and pre-renders both into PNG tiles so the glasses stay thin.
- **`solution.md`** — the worked solutions shown on the AI page.

## How the pieces connect

```
 camera ─▶ MediaMTX ─▶ web gateway ─▶ assignment reader ─┐
                                       (Gemini)          │  SSE
                                                         ▼
 solution.md ──────────── watched ──────────▶ document server ──▶ glasses app
                                              (renders tiles)      (this repo)
```

The glasses app talks to **one origin only**: the document server. Everything
upstream of it — the reader, the camera stack, the API keys — is the document
server's business, and is configured there rather than in the app.

## Where every variable lives

Each service owns one file. Nothing is configured in two places.

| File | Owns | Key settings |
|---|---|---|
| `test/.env.local` | the glasses app | `VITE_MD_TARGET` (dev proxy), `VITE_MD_SERVER` (packed build) |
| `.env` (this repo, next to `docker-compose.yml`) | the document server's deployment | `ASSIGNMENT_URL`, `ASSIGNMENT_TOKEN`, `ASSIGNMENT_DEBOUNCE_MS` |
| `vps/docker/.env` in the lookcam repo | the camera stack and the reader | `GEMINI_API_KEY`, `ASSIGNMENT_TOKEN`, `SNAPSHOT_TOKEN`, `DOMAIN`, `ASSIGNMENT_DOMAIN`, `EVENS_DOMAIN` |

`ASSIGNMENT_TOKEN` is the one value that must match across two files — this
repo's `.env` and the lookcam stack's. If the assignment page is empty and
`/assignment/status` reports an error, check that first.

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
