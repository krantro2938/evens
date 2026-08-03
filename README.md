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
- **`routine/review.md`** — the prompt for the *second* routine, which grades
  what the first one wrote and sends the weak problems back.
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
                                              Claude routine ──── solves
                                              (cloud session)
                                                    │  ▲
                                       every answer  │  │  points per problem,
                                       is graded     ▼  │  and what to fix
                                            Claude routine ──── reviews
                                              (Opus session)
```

The AI page shows whatever was last solved. When there is no solution for the
paper currently under the camera, it shows a trigger button instead: a tap hands
the transcription to a solver and the answer arrives on the glasses when it's
done. Every solution is kept in SQLite, so nothing is lost across restarts — see
[`server/README.md`](server/README.md#the-solve-loop).

## The review loop

An answer is not the end of it. Every solution that lands is handed to a
**second agent** — a different routine, on Opus — which marks it against a
rubric and reports points per problem. The server, not the reviewer, decides
what that means:

| Band | Points | Goes back when |
|---|---|---|
| **answer** — the first three problems by default | 15, answer only | the final answer is wrong, whatever it scored |
| **method** — everything after them | 18 = **5** answer + **13** working | the total is under 13 |

That split is the point. A method-band problem with the right number and an
unargued middle scores 5 and is re-solved; a well-argued attempt that slipped in
the arithmetic can score 13 and stand. **The working is worth more than the
answer**, which is how the papers this is built for are actually marked.

A problem that fails goes back **on its own**: the solver gets that problem, the
reviewer's `fix` note for it, and nothing else, and it submits just that section.
The server splices it into the document, so every problem that passed is kept
byte for byte rather than regenerated and re-checked. Then the whole thing is
graded again, up to `REVIEW_MAX_ROUNDS` rounds (3 by default, first attempt
included) — the only thing bounding what the loop spends.

**Every problem carries its own mark**, on the line under its answer, which is
the thing you actually act on — the total tells you whether to trust the paper,
this tells you which question to look at again:

```
**Ответ: 16/3**

*Rated 8/18 — Set up the definite integral explicitly, state the limits…*
```

and the total is in the footer under the byline:

```
Solved by claude-sonnet-5

Reviewed by claude-opus-5: 78/81
```

— or `61/81 — still short on 2, 4` when a round ran out. All of it is in the
*markdown* rather than only in the status feed, for the reason the byline is: the
glasses app ships separately from this server and the two drift for weeks, so
anything that has to be seen belongs in the document.

### On the glasses while it runs

The AI page reports which half of the loop is working:

| | |
|---|---|
| `CLAUDE IS SOLVING` · `1m 20s` | a first pass |
| `FIXING 2, 4` · `attempt 2 of 3 — 1m 20s` | a revision, and which problems |
| footer `— checking 45s` | the grader has the answer |
| footer `— 78/81`, or `— 61/81, 2,4 short` | the verdict on what is on screen |

**`Get quick solution`** (the menu, or just a tap while it works) shows the
answer that has *already* been submitted instead of waiting for the corrections
— the loop carries on behind it, the footer says `(newer ready)` when the better
version lands, and `Back to latest` picks it up. Worth having: a full round is
two cloud sessions, and sometimes you want the 61/81 now.

Setting it up is [`routine/review.md`](routine/review.md)'s own section: a second
routine, its own API trigger, `REVIEW_ROUTINE_ID` in `.env`. Without it nothing
is graded and the server behaves exactly as it did before — `REVIEW_ENABLED=0`
does the same while leaving the routine configured.

## The assignment as images

`/assignment/sheet*` renders the transcription to ordinary PNGs instead of BLE
tiles: one image per page — pixel-exact, the same layout and the same page
overlap the glasses show — and one tall image of the whole document at 2×, which
is the one to download. The **Assignment** tab on `cam.aansl.com` is built on
those, with a picker for the reader's earlier scans.

It answers what the glasses cannot: *read the transcription before you spend a
solve on it*, and *keep a copy of this sheet*.

A solution can include **figures** as well as prose and LaTeX — a graph, a
geometry diagram, vectors, a solution set on a number line. The solver writes a
```` ```viz ```` block holding the data; the server draws it, sizes it for the
panel, and makes sure a page boundary never lands in the middle of it. See
[figures](server/README.md#figures).

A tap always records the run server-side; **what picks it up is deliberately
separate**, and there are three solvers:

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
| `.env` (this repo, next to `docker-compose.yml`) | the document server's deployment | `ASSIGNMENT_URL`, `ASSIGNMENT_TOKEN`, `ASSIGNMENT_DEBOUNCE_MS`, `SOLVER_TOKEN`, `MESSAGE_TOKEN`, `ROUTINE_ID`, `ROUTINE_TOKEN`, `REVIEW_ROUTINE_ID`, `REVIEW_ROUTINE_TOKEN`, and the rubric (`REVIEW_*`, below) |
| the solve routine, at [claude.ai/code/routines](https://claude.ai/code/routines) | the solving agent | its prompt (a copy lives in `routine/solve.md`), its model, its **network allowlist**, and `SOLVER_TOKEN` again |
| the review routine, same place | the grading agent | its prompt (`routine/review.md`), **Opus**, the same network allowlist, and `SOLVER_TOKEN` again |
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

`SOLVER_TOKEN` is now in **three** places: this `.env` and *both* routines'
prompts. Render each with the script rather than pasting the file —
`./routine/render-prompt.sh` for the solver, `./routine/render-prompt.sh review`
for the grader — for the reason documented at the top of both prompts.

The rubric is configuration, not prose in a prompt, so the thresholds live in one
place and an agent cannot reason its way around them:

| Variable | Default | |
|---|---|---|
| `REVIEW_ANSWER_BAND` | `3` | how many problems at the front are answer-only |
| `REVIEW_ANSWER_MAX` | `15` | points for one of those |
| `REVIEW_METHOD_MAX` | `18` | points for a full-solution problem |
| `REVIEW_METHOD_ANSWER_POINTS` | `5` | of those 18, how many the answer alone is worth |
| `REVIEW_METHOD_PASS` | `13` | below this it is re-solved |
| `REVIEW_MAX_ROUNDS` | `3` | total attempts at a problem, first included |
| `REVIEW_ENABLED` | `1` | `0` grades nothing, routine or no routine |

## The encyclopedia

A maths reference you can browse mid-problem, under the **Mine** tile — which
now asks which half you want: your own answer, or the study pack.

Its content is the seventeen-article МИРЭА entrance-exam course from
[matesspace.h1n.ru](https://matesspace.h1n.ru/articles/maga/maga0/maga0.php),
plus, per topic, a **Формулы** sheet and a **Как решать** guide that the course
does not have — formulas alone, and "recognise the shape, pick the method".
Three topics the site leaves as stubs (линейные пространства, кратные
интегралы, ряды) are written out in full. There is one global **Шпаргалка**, a
**По заданию** shortcut that matches the assignment the camera read against the
pack's term index, and **Недавнее**.

**Nothing is rendered at runtime.** `tools/enc` converts the site's HTML maths
to TeX, cuts it into 151 nodes and renders every page once, here, with the same
Playwright + MathJax pipeline that renders your solutions. The result is
committed as `content/enc` and both backends do nothing but read a file:

    GET /enc/toc            the tree, node titles, page counts, term index
    GET /enc/node?id=m13.f  one node's pages

`server/enc.ts` and `offline/encyclopedia.py` are the same two routes over the
same files, so the glasses cannot tell which answered. That is the point: the
phone has no Chromium and no MathJax, and in the room where you want this it
has no network either.

**Text where text is enough, images where it is not**, decided per run of
blocks at pack time. A text page is ~400 bytes and paints in one container
write; a tile page is ~10 KB and four BLE pushes. The decision is measured, not
guessed — `@evenrealities/pretext` exposes the real panel font's advance widths,
so a glyph the firmware cannot draw scores zero and forces the page to be
rendered instead. Currently 44% text.

The tree browser is one text container and no images: a swipe repaints a
string. The reader carries both page kinds in one container layout, so moving
between prose and a formula is a write rather than a page rebuild.

    bun run tools/enc/build.ts            rebuild the pack from the cached course
    bun run tools/enc/build.ts --fetch    refresh that cache from the site first
    bun run tools/enc/offline-check.ts    warm the cache, cut the servers, reload

`tools/enc/cache/*.html` is committed on purpose — the source is one person's
shared host with no archive behind it, and the pack has to stay rebuildable
after it stops answering.

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
