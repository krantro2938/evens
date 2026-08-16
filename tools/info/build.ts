// Turns ../../../info/*.pdf into ../../content/info/index.json — the corpus the
// Инфоблок assistant answers from.
//
// Dev-machine only, like tools/deck. Nothing here runs on the VPS: the index is
// built once, committed, and mounted read-only into the server container. That
// is the same bargain content/enc makes, and for the same reason — the corpus
// changes on its own schedule, and a server that embedded 122 pages at boot
// would spend a minute and a few thousand API calls doing it every restart.
//
// Two external things it needs, both checked before any work starts:
//
//   pdftotext        poppler-utils. The PDFs are Google Docs exports with a
//                    real text layer, so there is no OCR step and no Chromium.
//   GEMINI_API_KEY   the same key the server answers with, because retrieval
//                    only works if the query and the documents were embedded by
//                    the same model.
//
//   GEMINI_API_KEY=… bun run build.ts
//
// See ../../server/info.ts for the half that reads this.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, "..", "..", "..", "info");
const OUT = join(HERE, "..", "..", "content", "info");

// ── the corpus ──────────────────────────────────────────────────────────────
//
// Named by hand rather than derived from the filename. The filename is
// "Ускоренный_курс_Адаптация_в_РТУ_МИРЭА.pdf", and the assistant cites the doc
// it answered from on a 576px panel — "Ускоренный курс Адаптация в РТУ МИРЭА"
// spends most of that width saying "ускоренный курс" five times over. The short
// name is what a curator would call the block.
//
// A file in info/ that is not in this map is a build error, not a silent skip:
// a block dropped from the corpus because nobody updated a map is exactly the
// failure that shows up as the glasses confidently saying "не знаю".
const DOCS: Record<string, string> = {
    "Ускоренный_курс_Адаптация_в_РТУ_МИРЭА.pdf": "Адаптация",
    "Ускоренный_курс_Внеучебная_деятельность.pdf": "Внеучебная деятельность",
    "Ускоренный курс_ДИ Факел.pdf": "ДИ «Факел»",
    "Ускоренный_курс_Куратор_в_социальных_сетях.pdf": "Соцсети",
    "Ускоренный курс_Университет.pdf": "Университет",
};

// ── chunking ────────────────────────────────────────────────────────────────

/**
 * How much text one chunk holds, and how much of the previous one it repeats.
 *
 * 900 characters is about a paragraph and a half of this material — small
 * enough that eight of them fit in a prompt without burying the answer, large
 * enough that a numbered step keeps the sentence that explains it. The overlap
 * exists because the interesting sentence is so often the one that straddles a
 * boundary: "Период проведения — 24-31 августа" is one line above the timings
 * that make it useful.
 */
const CHUNK_CHARS = 900;
const OVERLAP_CHARS = 220;

/** Below this a chunk is a stray heading, and embeds to noise. Merged forward. */
const MIN_CHUNK_CHARS = 120;

// ── embedding ───────────────────────────────────────────────────────────────

const EMBED_MODEL = process.env.INFO_EMBED_MODEL ?? "gemini-embedding-001";
/**
 * 768 rather than the model's native 3072.
 *
 * gemini-embedding-001 is trained with Matryoshka representation learning, so a
 * truncated-and-renormalised prefix is a valid embedding rather than a damaged
 * one. Retrieval over ~300 chunks of one small corpus does not need 3072 dims,
 * and the index is four times smaller — which matters because it is read into
 * memory whole by a container capped at 1g.
 */
const EMBED_DIMS = 768;
/** The API's per-request cap is 100 for batchEmbedContents. */
const EMBED_BATCH = 50;

/**
 * How many chunks a minute this is allowed to embed.
 *
 * The free tier's `embed_content_free_tier_requests` quota is 100 per minute,
 * and it counts CONTENTS, not HTTP calls — batching 50 into one request spends
 * 50 of the 100. Unpaced, this build sends 236 in a few seconds, gets two
 * batches through and then 429s for the rest of the minute.
 *
 * 90 rather than 100 because the window is a sliding one on Google's side and
 * the last few of a minute's allowance are not reliably there. At 90/min the
 * whole corpus takes under three minutes, which is a one-time cost paid on a
 * developer machine — set INFO_EMBED_RATE higher on a billed key.
 */
const EMBED_RATE_PER_MIN = Number(process.env.INFO_EMBED_RATE ?? 90);

const KEY = process.env.GEMINI_API_KEY ?? "";

// ────────────────────────────────────────────────────────────────────────────

interface Chunk {
    doc: string;
    /** The PDF page this chunk starts on, 1-based — what the citation says. */
    page: number;
    text: string;
}

/**
 * Everything pdftotext leaves behind that would cost embedding tokens or, worse,
 * survive into a prompt and be read aloud as content.
 *
 * The zero-width space is the loud one: these are Google Docs exports, and Docs
 * emits U+200B at the end of a great many lines. It is invisible in a terminal,
 * counts as a character everywhere else, and glues to the last word of the line
 * so that "августа​" and "августа" are different tokens.
 */
function clean(raw: string): string {
    return (
        raw
            .replace(/\r/g, "")
            .replace(/[​‌‍﻿­]/g, "")
            // Non-breaking and other exotic spaces: a real space everywhere, so
            // the wrap and the word split downstream see one kind of gap.
            .replace(/[   ]/g, " ")
            .replace(/[ \t]+$/gm, "")
    );
}

/**
 * Raw pdftotext output -> paragraphs, each tagged with the page it starts on.
 *
 * pdftotext preserves the PDF's own line breaks, which in an A4 Google Docs
 * export means every line is hard-wrapped at about 55 characters. Those breaks
 * are a property of the page, not of the text, and leaving them in would embed
 * ~55-character fragments and put ragged half-lines into the prompt — so
 * consecutive non-blank lines are joined back into one paragraph and a blank
 * line is the only separator that survives.
 *
 * A FORM FEED IS NOT A SEPARATOR. A paragraph that runs across a page break is
 * one paragraph; splitting it there is how you get a chunk ending mid-clause
 * and another beginning with a lowercase word.
 *
 * There is deliberately no heading detection here, and the first version of
 * this file had one. These documents do not mark headings in any way that
 * survives pdftotext — the numbering that looks structural ("22. В РТУ МИРЭА
 * всесторонне развита…") is ordinary body text, and matching it produced
 * "sections" that were the first 55 characters of a paragraph, cut at the
 * hard wrap. The page number is the citation instead: it is exact, it is
 * always right, and «Соцсети · с. 12» is something a curator can actually open.
 */
function paragraphs(raw: string): { page: number; text: string }[] {
    const out: { page: number; text: string }[] = [];

    let page = 1;
    let startedOn = 1;
    let current: string[] = [];

    const flush = () => {
        const text = current.join(" ").replace(/\s+/g, " ").trim();
        current = [];
        if (text) out.push({ page: startedOn, text });
    };

    for (const raw_line of clean(raw).split("\n")) {
        // A page break can land anywhere on the line, including in front of
        // text that continues the sentence above it.
        const breaks = raw_line.split("\f");
        for (let i = 0; i < breaks.length; i++) {
            if (i > 0) page++;
            const line = breaks[i].trim();
            if (!line) {
                flush();
                continue;
            }
            // A line that is nothing but a number is the printed page number.
            // Nothing else in this corpus is a bare integer on its own line,
            // and left in they become sentences like "…более 150 в год. 39".
            if (/^\d{1,3}$/.test(line)) continue;
            if (!current.length) startedOn = page;
            current.push(line);
        }
    }
    flush();
    return out;
}

/**
 * Paragraphs -> chunks of about CHUNK_CHARS, broken at paragraph boundaries.
 *
 * A paragraph longer than a whole chunk is split at sentence ends rather than
 * mid-word: these documents run to 2000-character numbered blocks with no blank
 * line anywhere in them, so "never split a paragraph" would produce chunks four
 * times the size of every other one, which then dominate every prompt they are
 * retrieved into.
 */
function chunkDoc(doc: string, raw: string): Chunk[] {
    const chunks: Chunk[] = [];
    let buffer = "";
    /** The page the buffer STARTS on — what the finished chunk is credited to. */
    let page = 1;
    /** The page of the most recently appended piece, i.e. where the buffer ENDS. */
    let lastPage = 1;

    const flush = () => {
        const text = buffer.trim();
        buffer = "";
        if (!text) return;
        // Too small to stand alone: glue it onto the previous chunk. A lone
        // fragment embeds to something near the centre of the corpus and is
        // then retrieved against everything.
        if (text.length < MIN_CHUNK_CHARS && chunks.length) {
            chunks[chunks.length - 1].text += ` ${text}`;
            return;
        }
        chunks.push({ doc, page, text });
    };

    const add = (piece: string, piecePage: number) => {
        if (buffer && buffer.length + piece.length + 1 > CHUNK_CHARS) {
            const tail = buffer.slice(-OVERLAP_CHARS);
            // The tail is the END of the chunk being flushed, so the chunk that
            // inherits it starts on lastPage — NOT on `page`, which is where
            // the flushed chunk began. Using `page` here means every chunk
            // carrying an overlap inherits its predecessor's page, and since
            // almost every chunk carries one the citation then never advances:
            // a 25-page document reports its last chunk as page 21.
            const tailPage = lastPage;
            flush();
            // Cut at a word boundary so the overlap does not open mid-word.
            const cut = tail.indexOf(" ");
            buffer = cut > 0 ? `${tail.slice(cut + 1)} ` : "";
            page = buffer ? tailPage : piecePage;
        }
        if (!buffer) page = piecePage;
        buffer += (buffer && !buffer.endsWith(" ") ? " " : "") + piece;
        lastPage = piecePage;
    };

    for (const para of paragraphs(raw)) {
        if (para.text.length <= CHUNK_CHARS) {
            add(para.text, para.page);
            continue;
        }
        // Oversized: split on sentence ends, keeping the terminator. These
        // documents run to 2000-character numbered blocks with no blank line
        // anywhere in them, and "never split a paragraph" would produce chunks
        // several times the size of every other one — which then dominate
        // every prompt they are retrieved into.
        const sentences = para.text.match(/[^.!?…]+[.!?…]+\s*|[^.!?…]+$/g) ?? [para.text];
        for (const sentence of sentences) add(sentence.trim(), para.page);
    }

    flush();
    return chunks;
}

// ── the API ─────────────────────────────────────────────────────────────────

/**
 * Embed a batch of chunks as DOCUMENTS.
 *
 * `taskType` is not decoration. gemini-embedding-001 projects a document and
 * the question that should find it into deliberately different places, and
 * asymmetric retrieval only works if each side declares which it is — the
 * server embeds with RETRIEVAL_QUERY against this. Getting the pair wrong does
 * not fail, it just retrieves worse, which is the hardest kind of bug to see.
 */
async function embedBatch(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents?key=${KEY}`,
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                requests: texts.map((text) => ({
                    model: `models/${EMBED_MODEL}`,
                    content: { parts: [{ text }] },
                    taskType: "RETRIEVAL_DOCUMENT",
                    outputDimensionality: EMBED_DIMS,
                })),
            }),
        },
    );

    if (!res.ok) {
        throw new Error(`embed ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }

    const body = (await res.json()) as { embeddings?: { values: number[] }[] };
    const embeddings = body.embeddings ?? [];
    if (embeddings.length !== texts.length) {
        throw new Error(`embed returned ${embeddings.length} vectors for ${texts.length} chunks`);
    }
    return embeddings.map((e) => normalise(Float32Array.from(e.values)));
}

/**
 * L2-normalise, so the server's similarity is a dot product and nothing more.
 *
 * Done here rather than there because it is the same arithmetic either way and
 * this is the machine that has the time. Truncating a Matryoshka embedding to
 * 768 dims leaves it un-normalised, so this is required, not tidying.
 */
function normalise(vector: Float32Array): Float32Array {
    let sum = 0;
    for (const value of vector) sum += value * value;
    const length = Math.sqrt(sum) || 1;
    for (let i = 0; i < vector.length; i++) vector[i] /= length;
    return vector;
}

// ── build ───────────────────────────────────────────────────────────────────

async function pdfText(path: string): Promise<string> {
    // -layout is REQUIRED, not a preference. These documents are justified, and
    // pdftotext's default mode reads a justified line as a run of separately
    // positioned word fragments — which it then emits in an order that is not
    // the reading order. One paragraph of the Университет block comes out as
    // "…выбрал свой путь развития с направлений: нами. Мы объединяем более
    // 10-ти ключевых от работы в Институтах…", which is fluent enough to
    // survive a skim and is nonsense. -layout keeps the visual order, at the
    // cost of runs of padding spaces that paragraphs() collapses anyway.
    //
    // Form feeds are KEPT (no -nopgbrk) because the page number is the
    // citation, and the form feed is the only thing that says where a page
    // ends. paragraphs() counts them and does not treat them as breaks.
    const proc = Bun.spawn(["pdftotext", "-layout", path, "-"], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (code !== 0) throw new Error(`pdftotext failed on ${path}: ${err.trim()}`);
    return out;
}

/**
 * `bun run build.ts --dry` chunks and prints, and calls nothing.
 *
 * Chunking is the half of this that is worth looking at with your own eyes —
 * a heading heuristic that has gone wrong produces chunks that read fine in
 * aggregate and retrieve badly — and looking at it should not cost 300
 * embedding calls each time.
 */
const DRY = process.argv.includes("--dry");

async function main(): Promise<void> {
    if (!KEY && !DRY) throw new Error("GEMINI_API_KEY is not set");

    // Fail before spending a minute on extraction if poppler is missing — the
    // error `pdftotext` gives when absent is an ENOENT from spawn, which reads
    // like a bug in this script rather than a missing package.
    if (!Bun.which("pdftotext")) {
        throw new Error("pdftotext not found — install poppler-utils");
    }

    const present = (await readdir(SOURCE)).filter((name) => name.toLowerCase().endsWith(".pdf"));
    const unknown = present.filter((name) => !(name in DOCS));
    if (unknown.length) {
        throw new Error(`info/ holds PDFs this build has no name for: ${unknown.join(", ")}`);
    }
    const missing = Object.keys(DOCS).filter((name) => !present.includes(name));
    if (missing.length) {
        throw new Error(`named in DOCS but not in info/: ${missing.join(", ")}`);
    }

    const chunks: Chunk[] = [];
    for (const file of Object.keys(DOCS)) {
        const text = await pdfText(join(SOURCE, file));
        const produced = chunkDoc(DOCS[file], text);
        console.log(
            `${DOCS[file].padEnd(24)} ${String(text.length).padStart(7)} chars -> ${produced.length} chunks`,
        );
        chunks.push(...produced);
    }

    if (DRY) {
        for (const chunk of chunks) {
            console.log(`\n── ${chunk.doc} · с. ${chunk.page} (${chunk.text.length})`);
            console.log(chunk.text);
        }
        const total = chunks.reduce((n, c) => n + c.text.length, 0);
        console.log(
            `\n${chunks.length} chunks, ${total} chars, mean ${Math.round(total / chunks.length)}`,
        );
        return;
    }

    console.log(`\nembedding ${chunks.length} chunks as ${EMBED_DIMS}-dim vectors…`);
    const vectors: Float32Array[] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH);

        // Pace against the per-minute quota BEFORE the call rather than
        // reacting to a 429 after it: a refused batch still spends its share of
        // the window, so a build that only backs off on failure converges on
        // being refused roughly as often as it succeeds.
        if (i > 0) {
            const wait = Math.ceil((batch.length / EMBED_RATE_PER_MIN) * 60_000);
            await Bun.sleep(wait);
        }

        // Retried, because a 429 part-way through would otherwise throw away
        // every embedding bought so far. The waits are in units of the quota
        // window — a five-second retry against a per-minute quota is just a
        // second refusal.
        let attempt = 0;
        for (;;) {
            try {
                vectors.push(...(await embedBatch(batch.map(chunkPrompt))));
                break;
            } catch (error) {
                if (++attempt > 5) throw error;
                const wait = String(error).includes("429") ? 65_000 : attempt * 5_000;
                console.warn(
                    `  batch at ${i} failed (${String(error).slice(0, 120)}), retrying in ${wait / 1000}s`,
                );
                await Bun.sleep(wait);
            }
        }
        console.log(`  ${Math.min(i + EMBED_BATCH, chunks.length)}/${chunks.length}`);
    }

    const flat = new Float32Array(chunks.length * EMBED_DIMS);
    vectors.forEach((vector, i) => flat.set(vector, i * EMBED_DIMS));

    await mkdir(OUT, { recursive: true });
    const index = {
        version: 1,
        built: new Date().toISOString().slice(0, 10),
        model: EMBED_MODEL,
        dims: EMBED_DIMS,
        chunks,
        // base64 of the raw Float32Array. A JSON array of 250k floats is ~5MB
        // of text the server would have to parse at boot; this is 1.3MB and a
        // single decode.
        vectors: Buffer.from(flat.buffer).toString("base64"),
    };

    const path = join(OUT, "index.json");
    await writeFile(path, JSON.stringify(index));
    const size = (await readFile(path)).byteLength;
    console.log(
        `\nwrote ${path} — ${chunks.length} chunks, ${(size / 1024 / 1024).toFixed(2)} MB`,
    );
}

/**
 * What actually gets embedded: the chunk with its provenance in front of it.
 *
 * A chunk that reads "Период проведения — 24-31 августа" answers a question
 * about the Факел schedule only if something in the embedded text says Факел.
 * The body of these documents refers to their own subject by pronoun constantly,
 * so the doc and section names carry real retrieval signal and cost ~8 tokens.
 */
function chunkPrompt(chunk: Chunk): string {
    return `${chunk.doc} — ${chunk.text}`;
}

await main();
