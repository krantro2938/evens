# Markdown server

Serves the repo-root `solution.md` to the Even Realities glasses AI page and
pushes live updates so the glasses re-render on save.

## Run

```bash
bun install
bun run start     # or: bun run dev  (auto-restart on edits)
```

Default port `8787` (override with `PORT`).

## Endpoints

| Route | Purpose |
|---|---|
| `GET /markdown` | `{ content, version }` — `version` is the file mtime (ms). Initial load + the app's 10s poll fallback. |
| `GET /events` | SSE stream. Emits `event: markdown` with `{ version, content }` on connect and whenever `solution.md` changes; `event: ping` heartbeats keep the stream alive. |

CORS is open so the app (served from the Vite dev origin) can reach it.

## Quick check

```bash
curl localhost:8787/markdown
curl -N localhost:8787/events    # then edit + save solution.md
```
