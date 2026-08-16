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

Documents can carry **figures** as well as prose and LaTeX — a graph, a geometry
diagram, vectors, a solution set. See [figures](#figures).

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
| `GET /settings/:key` | `{ key, value }` — device settings that must outlive the device. Fixed key list; today only `gallery-bridge` |
| `PUT /settings/:key` | `{"value"}` — an empty value forgets it. Where the phone's gallery-bridge URL lives, because the WebView does not keep localStorage across launches |
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
| `POST /assignment/control` | `{"action":"start\|stop\|reset\|restart\|extend\|complete\|toggle"}` — the same, named outright → `{ ok, action, detail? }`. `complete` is the operator saying "that's all of it" when the reader is waiting on an edge of the paper that will never come |
| `POST /assignment/photo[?reset=1&name=]` | **read a photo into the assignment** — the body IS the image (`image/jpeg\|png\|webp\|heic\|heif`). Forwards to the reader, which **merges** it into the current attempt exactly as it merges a camera frame, so several photos of one sheet build one transcription. `?reset=1` archives the current attempt and starts a new one from this photo instead → `{ ok, version, problems, done }` |
| `GET /assignment/photo` | the photo last published, as bytes — for showing what you sent |
| `GET /assignment/photo/meta` | the same as metadata, so a poll doesn't drag the bytes with it |
| `GET /assignment/sheet` | **the transcription as images**, metadata first: `{ version, scan, pages, page_width, page_height, full_width, full_height, scale, bytes }` |
| `GET /assignment/sheet.png[?download=1]` | the whole document in one tall PNG, rastered at `SHEET_SCALE` — the download |
| `GET /assignment/sheet/:n.png[?download=1]` | page `n` (0-based) at 576×252, **pixel-exact**: same layout, same greys, same `PAGE_OVERLAP` rows of shared context the glasses page through |

All three take `?version=` for an archived scan, like `/assignment/tiles`, and
render through the same markdown pipeline the tiles do — see
[`render/sheet.ts`](render/sheet.ts) for why the pages are a second screenshot
rather than a downscale of the first. This is what the camera site's Assignment
tab is built on: reading a transcription before spending a solve on it, and
keeping a copy of the sheet.

`status` is:

```jsonc
{
  "upstream": "open",        // our link to the reader: disabled|connecting|open|error
  "running": true,           // a capture job is going
  "done": false,             // the model says it has the whole assignment
  "captures": 3, "max_captures": 40,
  "reason": null,            // why the last job ended: done|stopped|max_captures|failed
  "problems": 2, "problems_complete": 1,
  "edges_unseen": ["bottom"], // edges of the PAPER no frame has shown yet — the
                              // reader's gate on `done`. Empty = the sheet has
                              // been covered, over as many frames as it took
  "next_target": "Show the bottom of the page, below problem 2",
  "feedback": {              // last model_response — where to point the camera
    "next_target": "Show the bottom of the page, below problem 2",
    "camera_advice": "move_down",
    "advice_detail": "Problem 3 starts below the frame.",
    "region": "top third", "more_content_beyond": ["bottom"],
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
| `GET /solution/claim` | The agent's first call: takes the oldest queued run and returns the assignment text **plus a one-time `run_token`**. `{"ok":false,"reason":"no_pending_run"}` with status 200 when the queue is empty, so a cron run that finds nothing exits cleanly. On a **revision run** it also carries `revision` — which problems to redo, the solution they belong to, and the reviewer's note on each. |
| `POST /solution/submit` | `{ markdown, model?, notes? }` with the run token → stores it, ends the run, pushes new tiles. `409 unknown_or_superseded_token` if the run is no longer the current one. A revision may instead send `{ sections: {"4": "## 4 …"} }`, which is **spliced** into the solution being corrected so every problem that passed is kept byte for byte; a key matching no heading is refused with the document's real numbering. |
| `POST /solution/fail` | `{ error }` with the run token → the reason shows on the glasses instead of a timeout. |

### the review loop's own routes

The second agent's side. `/review/claim` is gated by the same `SOLVER_TOKEN`;
submit and fail are identified by the one-time `review_token` the claim hands
back, exactly as the solve loop does it.

| Route | Purpose |
|---|---|
| `GET /review/claim` | takes the oldest queued review and returns the assignment, the solution, **the rubric keyed by the document's own problem numbers**, the round, the previous round's verdict, and a one-time `review_token`. `{"ok":false,"reason":"no_pending_review"}` with 200 on an empty queue. |
| `POST /review/submit` | `{ model?, summary?, problems: [{ id, band, points, answer_correct, notes, fix }] }` → stores the verdict and, if anything failed its band's rule, **creates the revision run itself** and fires the solver. Replies with `{ total, max_total, resolving, next }`. |
| `POST /review/fail` | `{ error }` → the solution is left ungraded with a reason rather than silently never marked. |
| `GET /review/status` | the grader's own status: rubric, state, last verdict, what is still outstanding. Also embedded in `/solution/status` as `review`. |
| `POST /solution/review` | ungated, like `/solve`: grade the newest solution by hand. For a solution submitted while the reviewer was misconfigured, or a second opinion. |

**The thresholds are applied here, not by the reviewer.** It reports points and
whether the answer is right; `review.ts` decides what that means. There is no
"send it back" flag in the payload on purpose — a grader that could set one
could also be talked out of setting it.

### the Инфоблок assistant

Kura's third tile: a question asked out loud on the glasses, answered from the
five информационные блоки in `info/`. Three hops — Mistral transcribes,
`gemini-embedding-001` retrieves, `gemini-3.5-flash` writes — in
[`info.ts`](info.ts).

| Route | Purpose |
|---|---|
| `POST /info/ask` | body is raw PCM s16le mono (`x-sample-rate`, default 16000), `x-device` names the conversation. Transcribes, then answers in the background. Replies `{ id, question }` as soon as there is a transcript, which is a second or two before there is an answer. `400` with `too_short` / `too_long` / `no_speech`; `413` past the body cap; `503` if the corpus or either key is missing. |
| `GET /info/ask/:id/events` | SSE. One `state` event carrying the whole run — question, wrapped lines, source, done — on connect and on every change, then the stream ends itself. Replays from the run, so a client racing its own POST cannot miss the opening tokens. |
| `POST /info/reset` | forget `x-device`'s thread. The glasses send this on leaving the page. |
| `GET /info/status` | corpus size and build date, the three model ids, and whether it is configured at all. |

**Two requests rather than one, because `EventSource` is GET-only** and cannot
carry a megabyte of audio, and a streamed `fetch` response body is not something
this WebView is known to do. `EventSource` is proven on this hardware by
`/messages/events`, so the audio goes up in a POST and the answer comes back on
a stream keyed to the id it returns.

**The answer is a list of wrapped lines, not a string.** The glasses cannot
measure their own font, so `info.ts` wraps with `@evenrealities/pretext` — the
same metrics `tools/deck` uses for the packed content — and the device only
cuts the lines into screens of eight. The citation under the answer is resolved
from a `[N]` marker the model is asked to end with, mapped back to the fragment
list here, rather than from the model naming the document itself.

**It is open**, like `/solution/status` and the assignment controls, for the same
reason: the client is an app packed onto a pair of glasses and cannot hold a
secret. What that costs is bounded by the body cap — 40 seconds of audio,
checked against `content-length` before the body is read, because Bun buffers a
request body eagerly and this is the only unbounded input the server has.

Three things that cost an afternoon each:

- **Gemini terminates SSE frames with `\r\n\r\n`.** A parser splitting on
  `"\n\n"` matches nothing at all — the whole answer arrives, is never framed,
  and the route reports an empty response with no error anywhere.
- **Thinking tokens are charged against `maxOutputTokens`.** `gemini-3.5-flash`
  spends ~280 of them on a prompt like this, so a 300-token cap returns nine
  tokens of answer and `finishReason: MAX_TOKENS` — a sentence cut off mid-word
  that looks exactly like a network failure. The cap is 2048; the prompt does
  the shortening.
- **`thinkingLevel: "none"` is rejected** with a 400 by this model. `"low"` is
  the floor.
- **The free-tier generate quota is 20 requests a day, per model, per project**
  (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`) — not per minute. That
  is what the answer chain is for, and why a 429 gets its own message on the
  panel («Слишком много вопросов подряд») rather than reading as a dead server.

**It never sends you somewhere else.** The prompt forbids deflecting to the
website, the СДО or a person, because the corpus itself deflects: Университет
с. 6 says in as many words that the reader can look the history up at
`mirea.ru`, and a model handed that fragment relays it. That is how the feature
came to answer «расскажи историю университета» by declining to.

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
| `GEMINI_API_KEY` | — | enables the **backup solver**. Unset, only the routine and the CLI runner can answer a tap |
| `BACKUP_SOLVER_MODEL` | `gemini-3.6-flash` | the backup's model. A 404 from Google means this id is the one thing to change |
| `BACKUP_SOLVER_DELAY_MS` | `150000` | how long a *triggered* run stays unclaimed before the backup takes it |
| `BACKUP_SOLVER_QUEUE_DELAY_MS` | `20000` | the same wait when the trigger is unconfigured or failed — nothing is coming but a runner someone may be watching |
| `REVIEW_ROUTINE_ID` | — | the grading routine. Empty: nothing is ever reviewed, and the server behaves as it did before the loop existed |
| `REVIEW_ROUTINE_TOKEN` | `$ROUTINE_TOKEN` | its API-trigger token; one trigger can serve two routines in the same account |
| `REVIEW_ENABLED` | `1` | `0` grades nothing while leaving the routine configured |
| `REVIEW_ANSWER_BAND` | `3` | how many problems at the front of the paper are graded on the answer alone |
| `REVIEW_ANSWER_MAX` | `15` | points for one of those. It fails on a wrong answer whatever it scored |
| `REVIEW_METHOD_MAX` | `18` | points for a full-solution problem |
| `REVIEW_METHOD_ANSWER_POINTS` | `5` | of those, how many the correct answer alone is worth — the rest is the working |
| `REVIEW_METHOD_PASS` | `13` | below this, the problem is re-solved. So a right answer with an unargued middle goes back and a well-argued slip can stand |
| `REVIEW_MAX_ROUNDS` | `3` | total attempts at a problem, the first included. **The only thing bounding what the loop spends** |
| `REVIEW_TIMEOUT_MS` | `1200000` | a claimed review that never submits fails after this |
| `REVIEW_QUEUE_TIMEOUT_MS` | `10800000` | a queued review nobody claims fails after this |
| `SHEET_SCALE` | `2` | how much denser `/assignment/sheet.png` is than the panel. Page images are always 1:1 and unaffected |
| `DOC_MAX_CHARS` | `200000` | the same ceiling for a hand-written document |
| `MISTRAL_API_KEY` | — | enables the **Инфоблок assistant**. Unset, `/info/*` answers 503 and Kura's third tile says so on its own page |
| `INFO_INDEX` | `../content/info/index.json` | the corpus, built by `tools/info` and mounted read-only. Absent, 503 |
| `INFO_STT_MODEL` | `voxtral-mini-latest` | the transcription-only Voxtral. The `-realtime` and `-tts` variants are different products and 400 here |
| `INFO_ANSWER_MODELS` | five flash models | the answer chain, tried in order. **A chain because the free-tier generate quota is 20 requests a day _per model_** — five rungs is five buckets. It only falls through before the first token; a model that fails mid-stream has already put text on the panel |
| `INFO_ANSWER_MODEL` | — | pins one model, ignoring the chain |
| `INFO_EMBED_MODEL` | `gemini-embedding-001` | **must match the model the index was built with** — the server refuses to load an index that disagrees, because a query embedded by one model against documents embedded by another retrieves noise without erroring |
| `INFO_TOP_K` | `10` | how many chunks reach the prompt. Six was too few for «расскажи историю университета»: that section is six chunks on its own, so the rest of the set was whatever else scored well |
| `INFO_MAX_SECONDS` | `30` | longest recording accepted. The glasses stop themselves at the same number; the body cap is separate and stricter |
| `INFO_MIN_SECONDS` | `0.6` | below this it is a mis-tap, not a question |
| `INFO_SILENCE_FLOOR` | `100` | sample deviation below which the capture is a dead mic. Only saves the round trip — Voxtral does return an empty string for real silence |
| `INFO_THREAD_TTL_MS` | `900000` | how long a device's conversation survives without a new question |
| `INFO_THREAD_TURNS` | `3` | how many previous turns are carried |

CORS is open so the app (served from the Vite dev origin) can reach it.

## Figures

A ```` ```viz ```` block in any document is drawn into the tiles as a figure.
Every document goes through the same renderer, so this works for a submitted
solution, the assignment, and a page you typed yourself alike.

````markdown
```viz
{"kind":"plot","x":[-3,3],"fns":[{"f":"x^2-3","label":"y"}],
 "points":[{"at":[1.73,0],"label":"√3"}],
 "caption":"y = x² − 3, zeros at ±√3"}
```
````

Four kinds — `plot`, `figure`, `bars`, `number-line` — specified for the model
that writes them in [`routine/solve.md`](../routine/solve.md#figures) and
implemented in [`render/viz/`](render/viz). Three things are worth knowing from
this side:

- **The block holds a spec, not SVG.** A model asked for SVG has to decide stroke
  widths, label sizes and which greys survive a 16-colour palette on a panel it
  cannot see; `render/viz/canvas.ts` already knows all of that, and a spec can be
  validated before anything is drawn. Model-authored SVG and HTML are not
  accepted at all.
- **A bad spec costs the figure, not the page.** It falls back to its `caption`
  in a bordered box and logs `[viz] …`. Nothing in this path can throw into the
  render — expressions like `x^2-3` are parsed by hand rather than `eval`'d,
  because that string arrives over HTTP from an agent.
- **Figures are placed, not just rendered.** Pages advance by 222 rows but show
  252, so consecutive pages share 30 — which is why a *line* of text survives
  being cut. A 170px figure does not, so `keepTogether` in
  [`tiles.ts`](render/tiles.ts) measures every figure and display equation in the
  laid-out document and shifts any that straddles a seam onto the next page.
  It logs `moved N block(s) off a page seam`, and warns if one could not be placed.

To see what the glasses will see, without the glasses:

```bash
bun run render/viz/preview.ts ../solution.md /tmp/out   # one PNG per page
```

## How the assignment bridge works

The reader already emits the assignment as markdown + LaTeX, so it plugs into
the same pipeline as `solution.md` — no new rendering code. `assignment.ts`
holds **one** upstream SSE connection shared by every glasses client (with
reconnect + backoff), and keeps two views of it:

- **the document** — refetched from `/assignment.md` and versioned by content
  hash. Deliberately *not* the reader's own `version` field, which only bumps on
  `/reset` and so would never signal a capture's edits. The hash also means a
  capture that refines nothing textual costs no render and no BLE push.
- **the status** — job state, coverage (`edges_unseen`, `next_target`) and the
  model's camera advice, pushed separately
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

## The review loop

The answer that lands is not the end of it. `submitSolution` hands the finished
document to a **second routine** ([`../routine/review.md`](../routine/review.md),
on Opus) which marks it problem by problem, and the ones that fall short come
back to the ordinary solve queue as a **revision run**.

```
 /solution/submit lands ──▶ mints a review + token, fires the review routine
                                                    │
 reviewer ◀─────────────────────────────────────────┘
    ├──▶ GET  /review/claim     assignment + solution + the rubric
    └──▶ POST /review/submit    points per problem
                    │
       thresholds applied HERE, not by the reviewer
                    │
                    ├── everything passed ──▶ done, score in the footer
                    └── something failed ───▶ createRun(revision) ──▶ the solver
                                               (that problem only, plus the
                                                reviewer's fix note)
                                                      │
                            sections spliced into the solution, and back
                            to the reviewer — up to REVIEW_MAX_ROUNDS
```

**Two bands, and the split is the point:**

| Band | Points | Goes back when |
|---|---|---|
| `answer` — the first `REVIEW_ANSWER_BAND` problems | 15, answer only | the answer is wrong, whatever it scored |
| `method` — the rest | 18 = 5 answer + 13 working | the total is under 13 |

A method-band problem with the right number and no argument scores 5 and is
re-solved. A well-argued attempt that slipped in the arithmetic can score 13 and
stand. The reviewer may move a problem between bands **only** when the paper
itself marks the parts (ЧАСТЬ А/В), because an explicit marking on the sheet is
better evidence than a positional default.

Three design decisions worth knowing:

- **`reviews` is its own table, not a `kind` column on `runs`.** `claimNextRun`
  hands out the oldest pending row regardless of what it is for, so one table
  would let the solver claim a review and the grader claim a solve. Two tables,
  two queues, two independent supersede rules — and the solve loop's invariants
  are untouched by any of this.
- **A revision goes through `createRun` like everything else.** Same token, same
  supersede-on-create, same routine. Tap solve while a revision is in flight and
  its token dies exactly as any other agent's would; there is no second path by
  which an answer can reach the display.
- **A revision submits `sections`, not a document.** They are spliced by problem
  number ([`sections.ts`](sections.ts)) so problems that already passed survive
  byte for byte rather than being regenerated and re-checked. A key that matches
  no heading is an error with the document's real numbering attached — dropping
  it quietly would leave a wrong answer on the glasses under a review that
  believed it had been fixed.

A fresh solve **stands down any grading in flight** (`cancelReviews`): that
verdict is about a document you have just decided to replace, and left running it
would queue a revision of the wrong paper in front of the one you asked for.

The verdict reaches the glasses **in the document itself**, twice over, and for
the reason the byline is there — see `withByline` in [`solver.ts`](solver.ts):

- **per problem**, as `*Rated 8/18 — …*` under that problem's answer
  (`withRatings` in [`review.ts`](review.ts), via `annotateSections`). The note
  is capped at ~110 characters, which is about two lines on the panel, and the
  reviewer's prompt says so — a mark you cannot read beside the working it
  grades is not worth the rows it costs.
- **in the footer**, as the total.

Both are part of the rendered markdown, so they change the document's content
hash: a verdict landing re-renders the tiles and pushes them, which is exactly
what should happen when new information about the answer arrives. An *ungraded*
solution comes back byte-identical, so it costs no render and no BLE push.

### Who drains the queue

Any of three solvers, and the server doesn't care which:

- **the routine** — fired on the tap itself, via its API trigger (below).
- **[`routine/runner.sh`](../routine/runner.sh)** — the same three endpoints from
  a machine with a logged-in `claude` CLI. The fallback when the routine isn't
  configured, and what to reach for when a run is stuck in the queue:

  ```bash
  SOLVER_TOKEN=… ./routine/runner.sh --watch    # keep draining
  SOLVER_TOKEN=… ./routine/runner.sh            # drain once
  ```

- **[`backup.ts`](backup.ts)** — this server, with one Gemini call, for the run
  neither of the above turns up for. It waits first (`BACKUP_SOLVER_DELAY_MS`,
  150s, or 20s when the trigger isn't even configured), because an agent that can
  check its own arithmetic is the better answer and cutting in front of it would
  spend a call to produce the worse one. Then it claims the run through
  `claimRun()` and submits through `submitSolution()` — the same functions over
  the same token as any agent, so a tap during its work supersedes it and its
  answer is refused on arrival. Unset `GEMINI_API_KEY` and the loop is exactly
  what it was: two solvers, and QUEUED means waiting.

  Its prompt is [`routine/solve-local.md`](../routine/solve-local.md), read from
  disk — the same file the CLI runner uses, so there is one prompt to maintain
  and a change to the figure spec reaches all of it. The image `COPY`s `routine/`
  for that reason.

**Which one answered is on the page.** Every solution's last line is
`*Solved by <model>*`, from the `model` the submitter reported — `claude-sonnet-5`
for the routine, `gemini-3.6-flash` for the backup. It is rendered into the
markdown rather than shown by the app because the glasses client is packed and
installed separately from this server and the two drift for weeks; anything that
has to be rendered to be seen belongs in the document. `/solution/status` carries
the same `model`, plus a `backup` block saying whether the backup exists.

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
