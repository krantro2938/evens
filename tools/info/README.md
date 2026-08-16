# info — the Инфоблок corpus

Turns the five PDFs in [`../../../info`](../../../info) into
`../../content/info/index.json`: the corpus Kura's Инфоблок tile answers
questions from.

Dev-machine only. Nothing here runs on the VPS and nothing here ships to the
glasses — the output is committed and mounted read-only into the server
container, the same bargain [`../enc`](../enc) makes with the encyclopedia.

```bash
bun run build.ts --dry              # chunk and print, calls nothing
GEMINI_API_KEY=… bun run build.ts   # chunk, embed, write the index
```

Needs `pdftotext` (poppler-utils) on PATH. It checks for both before doing any
work, because the errors otherwise arrive a minute in.

## What comes out

236 chunks of ~800 characters, each carrying the document it came from and the
page it starts on, plus one 768-dimension embedding each — about 1.3 MB, of
which 700 KB is the base64 vector block.

| Document | Pages | Cited as |
|---|---|---|
| Адаптация в РТУ МИРЭА | 25 | `Адаптация` |
| Внеучебная деятельность | 27 | `Внеучебная деятельность` |
| ДИ «Факел» | 10 | `ДИ «Факел»` |
| Куратор в социальных сетях | 21 | `Соцсети` |
| Университет | 39 | `Университет` |

A PDF in `info/` with no entry in `DOCS` is a build error rather than a silent
skip: a block dropped from the corpus because nobody updated a map shows up
later as the glasses confidently saying «В материалах этого нет».

## Three things that are not obvious

**`pdftotext -layout` is required.** These are justified Google Docs exports,
and the default mode reads a justified line as separately positioned word
fragments — which it emits in an order that is not the reading order. One
paragraph of the Университет block comes out as *«…выбрал свой путь развития с
направлений: нами. Мы объединяем более 10-ти ключевых от работы в
Институтах…»*: fluent enough to survive a skim, and nonsense. `-layout` keeps
the visual order at the cost of padding spaces, which the chunker collapses.

**The page number is the citation, and there is no section heading.** The first
version of this tool detected headings. These documents do not mark them in any
way that survives `pdftotext` — the numbering that looks structural (`22. В РТУ
МИРЭА всесторонне развита…`) is ordinary body text — so it produced "sections"
that were the first 55 characters of a paragraph, cut at the hard wrap. The page
is exact, always right, and «Соцсети · с. 12» is something a curator can open.

**The embedding is asymmetric.** Chunks are embedded with
`taskType: RETRIEVAL_DOCUMENT` here and questions with `RETRIEVAL_QUERY` in
`../../server/info.ts`. Getting that pair wrong does not fail — it retrieves
worse, quietly. The 768 dimensions are a Matryoshka truncation of the model's
native 3072 and are renormalised here, which is why the server can treat
similarity as a plain dot product.

## Pacing

The free tier's embed quota is **100 per minute and counts contents, not HTTP
calls** — batching 50 into one request spends 50 of the 100. Unpaced, the build
sends 236 in a few seconds, gets two batches through and 429s for the rest of
the minute. `EMBED_RATE_PER_MIN` (default 90) paces it to just under three
minutes; raise it with `INFO_EMBED_RATE` on a billed key.

## Rebuilding

Changing the corpus means changing what is in `info/` and re-running this. The
server loads the index once at first use and holds it, so a new index needs a
`docker compose restart evens` — not a rebuild, since it is mounted rather than
baked in.
