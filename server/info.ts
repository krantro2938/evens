// The Инфоблок assistant: a question asked out loud on the glasses, answered
// from the five информационные блоки in info/.
//
// Three hops, and each is a different vendor's failure mode:
//
//   Mistral   voxtral-mini-latest turns the recording into a question. The
//             glasses mic is 16 kHz mono PCM, which is what Voxtral wants, so
//             this is a header away from a straight passthrough.
//   Gemini    gemini-embedding-001 finds the handful of chunks that might
//             contain the answer, out of the 236 built by tools/info.
//   Gemini    a CHAIN of flash models writes the answer from those chunks and
//             nothing else, and streams it. A chain because the free tier's
//             generate quota is 20 requests a day PER MODEL — five rungs is
//             five buckets. See `answerModels`.
//
// WHAT THIS MODULE OWNS THAT THE ROUTES DO NOT: the corpus, the panel geometry,
// and the fact that an answer is a sequence of WRAPPED LINES rather than a
// string. The glasses cannot measure their own font — see kura/src/utils.ts,
// whose textWidth is a deliberate overestimate good enough for centring a tile
// label and nothing more — so text that has to fill the panel is wrapped here,
// against the same @evenrealities/pretext metrics tools/deck uses for the
// static content. That is the same bargain the rest of this app makes: the
// device draws, the developer machine or the server measures.
//
// Everything is in memory and nothing is persisted. A question is worth about
// four seconds and a fifth of a cent; a question that outlives a container
// restart is worth nothing at all.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getTextWidth } from "@evenrealities/pretext";

// ── configuration ───────────────────────────────────────────────────────────

/**
 * A number from the environment, tolerant of the empty string.
 *
 * `Number("")` is 0, not NaN, so the obvious `Number(process.env.X ?? 10)`
 * silently yields ZERO for a var that is present and empty — and every var here
 * is present and often empty, because docker-compose.yml enumerates the
 * environment and passes `${X:-}`. A top-k of 0 retrieves nothing and answers
 * every question with «В материалах этого нет».
 */
function num(raw: string | undefined, fallback: number): number {
    const value = Number(raw);
    return raw === undefined || raw.trim() === "" || Number.isNaN(value) ? fallback : value;
}

const cfg = {
    /** Built by tools/info and mounted read-only, exactly like content/enc. */
    index: process.env.INFO_INDEX ?? join(import.meta.dir, "..", "content", "info", "index.json"),

    geminiKey: process.env.GEMINI_API_KEY ?? "",
    geminiBase: process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com",
    /**
     * The models that write the answer, in order, first one that works wins.
     *
     * A LIST BECAUSE THE FREE TIER IS PER MODEL PER DAY. The quota that bites
     * is `GenerateRequestsPerDayPerProjectPerModel-FreeTier`, and its value is
     * **20 requests a day** — but the bucket is per model, so five models is
     * five buckets and about a hundred questions a day instead of twenty. Same
     * shape as the lookcam reader's chain, for the same reason.
     *
     * Ordered best-first: 3.5-flash answers these questions well, and the
     * -lite rungs at the end are there to keep the page answering at all once
     * the better ones are spent, not because they are as good.
     *
     * `INFO_ANSWER_MODEL` (singular) still works and pins a single model.
     */
    // `||`, NOT `??`. docker-compose.yml enumerates the environment and passes
    // `${INFO_ANSWER_MODELS:-}`, so the var is always PRESENT and usually the
    // empty string — which `??` accepts, splits into nothing, and leaves the
    // chain empty. `||` treats empty as unset, which is what a compose default
    // means.
    answerModels: (
        process.env.INFO_ANSWER_MODELS ||
        process.env.INFO_ANSWER_MODEL ||
        "gemini-3.5-flash,gemini-3.6-flash,gemini-3.7-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite"
    )
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean),
    /**
     * Must be the model the index was built with — a query embedded by one
     * model and documents embedded by another land in unrelated spaces, and
     * retrieval degrades to noise without erroring anywhere. Checked at load
     * against the `model` the index records.
     */
    embedModel: process.env.INFO_EMBED_MODEL ?? "gemini-embedding-001",

    mistralKey: process.env.MISTRAL_API_KEY ?? "",
    mistralBase: process.env.MISTRAL_BASE_URL ?? "https://api.mistral.ai",
    sttModel: process.env.INFO_STT_MODEL ?? "voxtral-mini-latest",

    /**
     * How many chunks reach the prompt.
     *
     * Ten rather than six because of the questions that deserve a long answer.
     * «Расскажи историю университета» wants the whole history section, which is
     * six chunks on its own — at six the retrieved set was half history and
     * half whatever else scored well, and one of those others was the sentence
     * telling the reader to look the history up on the university's website.
     * A model given that fragment and a forty-word budget relays it, which is
     * how this feature came to answer a question by declining to.
     */
    topK: num(process.env.INFO_TOP_K, 10),
    /**
     * The longest recording accepted, in seconds. At 16 kHz mono s16le that is
     * 32 KB a second, so 30s is ~960 KB — the client stops at the same number
     * (INFO_MAX_SECONDS in kura/src/constants.ts) and this is the backstop for
     * a client that did not. See the note on Bun and buffered bodies in the
     * deploy notes: a request body is the one thing that bounds this process's
     * memory, so it is bounded here.
     */
    maxSeconds: num(process.env.INFO_MAX_SECONDS, 30),
    /** Below this there is no question, only a mis-tap. */
    minSeconds: num(process.env.INFO_MIN_SECONDS, 0.6),

    /** How long a device's thread survives without a new question. */
    threadTtlMs: num(process.env.INFO_THREAD_TTL_MS, 15 * 60_000),
    /** How many previous turns are carried. */
    threadTurns: num(process.env.INFO_THREAD_TURNS, 3),
};

/** The panel, as the glasses see it. Mirrors kura/src/constants.ts. */
const PANEL_TEXT_WIDTH = 556; // BODY_W 576 less CONTAINER_PAD on each side
const PANEL_MAX_LINES = 8; // a ninth makes the host attach a scroller

export const infoConfigured = (): boolean =>
    Boolean(cfg.geminiKey) && Boolean(cfg.mistralKey) && existsSync(cfg.index);

// ── the corpus ──────────────────────────────────────────────────────────────

interface Chunk {
    doc: string;
    page: number;
    text: string;
}

interface Index {
    version: number;
    built: string;
    model: string;
    dims: number;
    chunks: Chunk[];
    /** chunks.length × dims float32s, L2-normalised, base64 of the raw buffer. */
    vectors: Float32Array;
}

let index: Index | null = null;
let loading: Promise<Index> | null = null;

/**
 * Read the index once and keep it.
 *
 * ~1.3 MB on disk and about 1 MB resident, against a container capped at 1g.
 * Lazy rather than at boot so a server with no corpus mounted starts normally
 * and answers 503 on this one route, which is how content/enc behaves too.
 */
async function loadIndex(): Promise<Index> {
    if (index) return index;
    if (loading) return loading;

    loading = (async () => {
        const raw = JSON.parse(await readFile(cfg.index, "utf8"));
        if (raw.model !== cfg.embedModel) {
            // Not fatal by itself — but silently retrieving against a mismatched
            // space produces answers that are confidently about the wrong page,
            // which is worse than a route that refuses.
            throw new Error(
                `index was built with "${raw.model}" but INFO_EMBED_MODEL is "${cfg.embedModel}" — rebuild tools/info or set the var to match`,
            );
        }
        const bytes = Buffer.from(raw.vectors, "base64");
        const vectors = new Float32Array(
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        );
        const expected = raw.chunks.length * raw.dims;
        if (vectors.length !== expected) {
            throw new Error(
                `index holds ${vectors.length} floats for ${raw.chunks.length} chunks × ${raw.dims} dims (expected ${expected})`,
            );
        }
        index = { ...raw, vectors } as Index;
        console.log(
            `[info] corpus ${raw.chunks.length} chunks, ${raw.dims}d, built ${raw.built} (${raw.model})`,
        );
        return index!;
    })();

    try {
        return await loading;
    } finally {
        // Cleared either way: a failed load should be retried on the next
        // question rather than remembered as a permanently broken server.
        loading = null;
    }
}

// ── the panel ───────────────────────────────────────────────────────────────

/**
 * Greedy word wrap against the real panel metrics.
 *
 * The same routine as tools/deck/build.ts, and deliberately a copy rather than
 * a shared module — that is a bun script on a developer machine and this is a
 * container, and the thing they actually share is the font, which comes from
 * the package. A long word is broken rather than allowed to overhang: a line
 * wider than its container is the scroller failure, and the scroller then eats
 * the swipes that page the answer.
 */
function wrap(line: string, width = PANEL_TEXT_WIDTH): string[] {
    if (!line.trim()) return [""];

    // A wrapped enumeration item reads as two items unless its continuation is
    // indented — «— институт тонких химических / технологий» is one entry, and
    // without the indent the second half looks like the next one.
    const bullet = /^(\s*(?:[—-]\s+|\d+[.)]\s+))/.exec(line);
    const indent = bullet ? " ".repeat(Math.min(bullet[1].length, 4)) : "";

    const out: string[] = [];
    let current = "";

    const push = () => {
        if (current) out.push(current);
        current = "";
    };

    for (const word of line.split(/\s+/)) {
        const prefix = current ? `${current} ` : out.length ? indent : "";
        const candidate = prefix + word;
        if (getTextWidth(candidate) <= width) {
            current = candidate;
            continue;
        }
        push();
        let rest = out.length ? indent + word : word;
        while (getTextWidth(rest) > width) {
            let cut = rest.length - 1;
            while (cut > 1 && getTextWidth(rest.slice(0, cut)) > width) cut--;
            out.push(rest.slice(0, cut));
            rest = indent + rest.slice(cut);
        }
        current = rest;
    }
    push();
    return out.length ? out : [""];
}

/**
 * Everything the panel font cannot draw, removed rather than sent.
 *
 * A glyph the face lacks does not draw a box — the host logs `glyph dsc. not
 * found` and DRAWS NOTHING, so an emoji is an invisible hole in a sentence and
 * nobody can tell the difference between that and a model that stopped early.
 * Cyrillic is fine (the fallback chain reaches evenroster_crylgrek, which is
 * what the whole of this app's content relies on); markdown is not a glyph
 * problem but a model that was asked for plain text and produced `**` anyway.
 */
function forPanel(text: string): string {
    return (
        text
            .replace(/```[\s\S]*?```/g, " ")
            .replace(/[*_`#]+/g, "")
            .replace(/\r\n?/g, "\n")
            // Whatever bullet the model reached for becomes the one the packed
            // content uses, so an enumeration looks the same here as it does in
            // Документация.
            .replace(/^[ \t]*[-•·*]\s+/gm, "— ")
            // Folded to the characters this app has actually drawn. «», — and …
            // are all over the packed content and are proven; the en dash, the
            // various curly quotes and the non-breaking hyphen are not, and an
            // unproven glyph does not fail loudly — it draws nothing, leaving a
            // gap that reads as a model that lost a word. The source PDFs write
            // ranges as "6-7" anyway.
            .replace(/[–‒‑]/g, "-")
            .replace(/[‘’‚‛]/g, "'")
            .replace(/[“”„‟]/g, '"')
            // NEWLINES SURVIVE THIS, and they have to: they are what makes an
            // enumeration a list of lines rather than one run-on sentence, and
            // \n is not a Cyrillic letter — leaving it out of the class below
            // silently flattened every list back into a paragraph.
            .replace(/[^\p{Script=Cyrillic}\p{Script=Latin}0-9 \n.,:;!?()[\]«»"'—\-…/%№+=@]/gu, "")
            // A blank line costs 27px of an eight-line panel and buys nothing.
            .replace(/\n{2,}/g, "\n")
            .replace(/[ \t]{2,}/g, " ")
            .replace(/[ \t]+\n/g, "\n")
            .trim()
    );
}

// ── speech to text ──────────────────────────────────────────────────────────

/**
 * A 44-byte RIFF header in front of the raw capture.
 *
 * The glasses hand the WebView bare PCM — there is no container anywhere in the
 * path — and Voxtral needs a file it can identify. Done here rather than in the
 * client because the client would have to build it in a WebView on a phone,
 * and because the server is where the size limit has to be enforced anyway.
 */
function toWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
    const out = new Uint8Array(44 + pcm.length);
    const view = new DataView(out.buffer);
    const ascii = (offset: number, text: string) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };

    ascii(0, "RIFF");
    view.setUint32(4, 36 + pcm.length, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true); // PCM header size
    view.setUint16(20, 1, true); // format 1 = PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate, 16-bit mono
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    ascii(36, "data");
    view.setUint32(40, pcm.length, true);
    out.set(pcm, 44);
    return out;
}

/**
 * How loud the capture is, as the standard deviation of the samples.
 *
 * DEVIATION, NOT PLAIN RMS, and that is the point: a mic that is muted, absent
 * or not yet streaming delivers a CONSTANT value — often a small DC offset
 * rather than zeroes — whose plain RMS is comfortably above any floor you would
 * pick, and whose deviation is zero. Subtracting the mean is what separates "no
 * signal" from "quiet".
 */
function loudness(pcm: Uint8Array): number {
    const samples = new Int16Array(
        pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.byteLength & ~1)),
    );
    if (!samples.length) return 0;

    let sum = 0;
    for (const sample of samples) sum += sample;
    const mean = sum / samples.length;

    let variance = 0;
    for (const sample of samples) variance += (sample - mean) ** 2;
    return Math.sqrt(variance / samples.length);
}

/**
 * Below this the capture is a dead microphone, not a quiet question.
 *
 * A COURTESY, NOT A SAFETY NET, and the distinction is worth keeping straight:
 * Voxtral answers 30s of a constant signal with an empty string (measured), so
 * the `no_speech` check below catches this case on its own. What the floor buys
 * is the two seconds and the API call it takes to find that out — a mic that
 * never opened should say «Не расслышал» at once rather than after a round trip
 * to Paris.
 *
 * So it is deliberately set where only a dead mic falls: a constant signal
 * measures 0, and a real spoken question over this path measured ~5500. 100 of
 * a possible 32768 is about -50 dBFS, far below any speech and far above
 * nothing at all. Raising it to where it might catch "too quiet" would trade a
 * failure that cannot happen for one that can.
 */
const SILENCE_FLOOR = num(process.env.INFO_SILENCE_FLOOR, 100);

async function transcribe(wav: Uint8Array): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "question.wav");
    form.append("model", cfg.sttModel);
    // The corpus is Russian and so is every question anyone will ask it.
    // Declaring it stops Voxtral guessing another language off a noisy first
    // second and transcribing the rest phonetically into it.
    form.append("language", "ru");

    const res = await fetch(`${cfg.mistralBase}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.mistralKey}` },
        body: form,
    });

    const raw = await res.text();
    if (!res.ok) {
        throw new Error(`Mistral ${res.status} (model="${cfg.sttModel}"): ${raw.slice(0, 400)}`);
    }
    let body: { text?: string };
    try {
        body = JSON.parse(raw);
    } catch {
        throw new Error(`Mistral returned non-JSON: ${raw.slice(0, 300)}`);
    }
    return (body.text ?? "").trim();
}

// ── retrieval ───────────────────────────────────────────────────────────────

async function embedQuery(text: string): Promise<Float32Array> {
    const res = await fetch(
        `${cfg.geminiBase}/v1beta/models/${cfg.embedModel}:embedContent`,
        {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": cfg.geminiKey },
            body: JSON.stringify({
                content: { parts: [{ text }] },
                // The other half of the pair tools/info uses. gemini-embedding
                // projects a question and the passage that answers it into
                // deliberately different places; declaring which side this is
                // is what makes them line up.
                taskType: "RETRIEVAL_QUERY",
                outputDimensionality: index?.dims ?? 768,
            }),
        },
    );
    if (!res.ok) {
        throw new Error(`embed ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = (await res.json()) as { embedding?: { values: number[] } };
    const values = body.embedding?.values;
    if (!values) throw new Error("embed returned no vector");

    const vector = Float32Array.from(values);
    let sum = 0;
    for (const value of vector) sum += value * value;
    const length = Math.sqrt(sum) || 1;
    for (let i = 0; i < vector.length; i++) vector[i] /= length;
    return vector;
}

/**
 * The chunks most likely to hold the answer.
 *
 * TWO QUERIES WHEN THERE IS A THREAD, which is the whole of this app's
 * follow-up support. «А во сколько?» after «Когда Факел?» embeds to nothing in
 * particular on its own — it has no content words — so it is also embedded
 * glued to the previous question, and the two result sets are merged. The
 * alternative is a round trip to a model to rewrite the follow-up into a
 * standalone question, which is more accurate and costs most of a second on a
 * device someone is wearing; the generation step sees the thread anyway, so
 * only retrieval needed help and this is enough of it.
 *
 * Both embeddings are in flight at once, so a follow-up costs the same wall
 * clock as a fresh question.
 */
async function retrieve(question: string, previous: string | null): Promise<Chunk[]> {
    const loaded = await loadIndex();
    const { chunks, dims, vectors } = loaded;

    const queries = await Promise.all(
        previous
            ? [embedQuery(question), embedQuery(`${previous} ${question}`)]
            : [embedQuery(question)],
    );

    // Best score across the queries, so a chunk that only the combined query
    // finds competes on equal terms with one the bare question found.
    const best = new Float64Array(chunks.length).fill(-Infinity);
    for (const query of queries) {
        for (let i = 0; i < chunks.length; i++) {
            let score = 0;
            const base = i * dims;
            for (let d = 0; d < dims; d++) score += query[d] * vectors[base + d];
            if (score > best[i]) best[i] = score;
        }
    }

    return Array.from(best)
        .map((score, i) => ({ score, chunk: chunks[i] }))
        .sort((a, b) => b.score - a.score)
        .slice(0, cfg.topK)
        .map((hit) => hit.chunk);
}

// ── the answer ──────────────────────────────────────────────────────────────

/**
 * What the model is for, and — as much as a prompt can — what it is not for.
 *
 * The length limit is the load-bearing line. This is a 576×288 panel eight
 * lines tall, worn on your face, read while you are standing in front of a
 * group of first-years; an answer that needs a second page is an answer you
 * stopped reading. Everything else here exists to stop the two failure modes
 * that make a reference worse than no reference: answering from what the model
 * knows about Russian universities in general rather than from these five
 * documents, and answering at all when the documents do not say.
 */
const SYSTEM_PROMPT = [
    "Ты — справочник куратора РТУ МИРЭА на дисплее умных очков.",
    "Отвечай по-русски и ТОЛЬКО по приведённым фрагментам информационных блоков.",
    "ВСЕГДА отвечай по существу вопроса.",
    "НИКОГДА не отправляй за ответом в другое место: не предлагай посмотреть на сайте," +
        " в СДО, в расписании, в материалах или спросить у кого-то.",
    "Если фрагмент сам советует что-то посмотреть на сайте — это часть материала, а не ответ:" +
        " изложи то, что во фрагментах есть, своими словами.",
    "Если фрагменты отвечают частично — расскажи всё, что в них есть, и не извиняйся за неполноту.",
    "Ответь «В материалах этого нет» — ровно этими словами — только если по теме вопроса" +
        " во фрагментах нет вообще ничего.",
    "Длина по вопросу: на простой вопрос одно-два предложения;" +
        " на вопрос про историю, состав, список, структуру или порядок действий — подробно," +
        " до 150 слов.",
    "Перечисление оформляй отдельными строками, каждая начинается с «— ».",
    "В остальном — обычный текст, без markdown, без заголовков, без нумерации.",
    "В самом конце укажи номер использованного фрагмента в квадратных скобках, например [2].",
].join(" ");

interface Turn {
    q: string;
    a: string;
}

function buildContents(question: string, chunks: Chunk[], history: Turn[]) {
    const fragments = chunks
        .map((chunk, i) => `[${i + 1}] ${chunk.doc}, с. ${chunk.page}:\n${chunk.text}`)
        .join("\n\n");

    return [
        // The thread, as real turns rather than a transcript pasted into the
        // prompt — which is what lets «а во сколько?» resolve against the model's
        // own previous answer instead of being described to it.
        ...history.flatMap((turn) => [
            { role: "user", parts: [{ text: turn.q }] },
            { role: "model", parts: [{ text: turn.a }] },
        ]),
        {
            role: "user",
            parts: [{ text: `ФРАГМЕНТЫ:\n\n${fragments}\n\nВОПРОС: ${question}` }],
        },
    ];
}

/**
 * Stream the answer, calling `onText` with each delta.
 *
 * maxOutputTokens is 3072 for a 150-word answer, and that is not slack.
 * gemini-3.5-flash is a thinking model and `thoughtsTokenCount` is charged
 * against the SAME budget as the visible answer — a 300-token cap on this
 * prompt spends 287 on thoughts and returns nine tokens of answer with
 * finishReason MAX_TOKENS, i.e. a sentence cut off mid-word that looks exactly
 * like a network failure. The length limit is the prompt's job; this number
 * exists only to bound a runaway.
 *
 * thinkingLevel is "low" and cannot be "none" — that value is rejected with a
 * 400 by this model.
 */
class ModelError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

/** A refusal another model might not give: quota, overload, a bad model id. */
const worthAnotherModel = (status: number): boolean =>
    status === 429 || status === 404 || status === 400 || status >= 500;

/**
 * Try each model in turn until one answers.
 *
 * FALLING THROUGH IS ONLY SAFE BEFORE THE FIRST TOKEN. Once a model has put
 * text on the panel, a second model starting over would append a whole second
 * answer to the first — so a mid-stream failure is fatal to the run rather than
 * a reason to retry, and that is what `produced` guards.
 *
 * Returns the model that answered, for the log.
 */
async function streamAnswer(
    question: string,
    chunks: Chunk[],
    history: Turn[],
    onText: (delta: string) => void,
): Promise<string> {
    let last: unknown = new Error("no answer models configured");

    for (const model of cfg.answerModels) {
        let produced = false;
        try {
            await streamOnce(model, question, chunks, history, (delta) => {
                produced = true;
                onText(delta);
            });
            return model;
        } catch (err) {
            last = err;
            if (produced) throw err;
            const status = err instanceof ModelError ? err.status : 0;
            if (status && !worthAnotherModel(status)) throw err;
            console.warn(`[info] ${model} failed (${String(err).slice(0, 120)}), next rung`);
        }
    }

    throw last;
}

async function streamOnce(
    model: string,
    question: string,
    chunks: Chunk[],
    history: Turn[],
    onText: (delta: string) => void,
): Promise<void> {
    const res = await fetch(
        `${cfg.geminiBase}/v1beta/models/${model}:streamGenerateContent?alt=sse`,
        {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": cfg.geminiKey },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
                contents: buildContents(question, chunks, history),
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 3072,
                    thinkingConfig: { thinkingLevel: "low" },
                },
            }),
        },
    );

    if (!res.ok || !res.body) {
        throw new ModelError(
            `Gemini ${res.status} (model="${model}"): ${(await res.text()).slice(0, 400)}`,
            res.status,
        );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const consume = (frame: string) => {
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) return;
        const payload = line.slice(6).trim();
        if (!payload || payload === "[DONE]") return;

        try {
            const parsed = JSON.parse(payload);
            const parts = parsed?.candidates?.[0]?.content?.parts ?? [];
            for (const part of parts) {
                // A thought part carries a thoughtSignature and no text, or text
                // flagged as thought — neither belongs on the panel.
                if (part?.thought) continue;
                if (part?.text) onText(part.text as string);
            }
        } catch {
            // A frame that will not parse is one frame of an answer that is
            // still arriving; losing it beats aborting the stream.
        }
    };

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // CARRIAGE RETURNS ARE STRIPPED FIRST, and this is not tidying.
        // Gemini terminates every SSE frame with \r\n\r\n, so a parser that
        // splits on "\n\n" matches nothing at all: the whole answer arrives,
        // is never framed, and the route reports an empty response with no
        // error anywhere to say why.
        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");

        // A chunk off the socket is not a frame — splitting on "\n" alone
        // delivers half a JSON object.
        let split: number;
        while ((split = buffer.indexOf("\n\n")) !== -1) {
            consume(buffer.slice(0, split));
            buffer = buffer.slice(split + 2);
        }
    }

    // A stream that ended without its final blank line still has an answer in
    // it, and that answer is usually the last sentence.
    if (buffer.trim()) consume(buffer);
}

// ── runs ────────────────────────────────────────────────────────────────────

export interface RunState {
    id: string;
    /** What Voxtral heard. Shown on the panel before the answer arrives. */
    question: string;
    /** The answer so far, wrapped to the panel. The client only paginates. */
    lines: string[];
    /** "Соцсети · с. 7", resolved from the [N] the model ends with. */
    source: string;
    done: boolean;
    /** Set instead of an answer. Already panel-safe. */
    error: string;
}

interface Run extends RunState {
    device: string;
    at: number;
    listeners: Set<() => void>;
}

const runs = new Map<string, Run>();
const threads = new Map<string, { turns: Turn[]; at: number }>();

/** Runs and threads are small, but they are unbounded without this. */
function sweep(): void {
    const now = Date.now();
    for (const [id, run] of runs) {
        if (now - run.at > 10 * 60_000) runs.delete(id);
    }
    for (const [device, thread] of threads) {
        if (now - thread.at > cfg.threadTtlMs) threads.delete(device);
    }
}

function notify(run: Run): void {
    for (const listener of run.listeners) {
        try {
            listener();
        } catch (err) {
            console.error("[info] listener failed:", err);
        }
    }
}

export function getRun(id: string): RunState | undefined {
    const run = runs.get(id);
    if (!run) return undefined;
    const { device: _device, at: _at, listeners: _listeners, ...state } = run;
    return state;
}

export function subscribeRun(id: string, fn: () => void): () => void {
    const run = runs.get(id);
    if (!run) return () => {};
    run.listeners.add(fn);
    return () => run.listeners.delete(fn);
}

/**
 * The trailing "[2]" the prompt asks for, turned into something readable.
 *
 * Resolved from the fragment list rather than trusting the model to name the
 * document and page itself: it has both in front of it and would mostly get
 * them right, and "mostly" on a citation is worse than none — a curator who
 * opens с. 7 and finds nothing stops believing the next one too.
 */
function splitSource(text: string, chunks: Chunk[]): { body: string; source: string } {
    // Tolerant of what models actually emit rather than only what was asked
    // for, and it has been wrong twice:
    //
    //   - a full stop AFTER the bracket ("…31 августа [1].") is the common
    //     case, and anchoring the bracket to the very end matched none of them;
    //   - a long answer drawn from several fragments ends "[1] [2] [3] [5] [6]."
    //     rather than with one marker. Matching a single group then consumed
    //     only the last of them and left "[1] [2] [3] [5]" on the panel.
    //
    // So: a whole trailing RUN of groups, however they are punctuated. The
    // first number wins, because one status line has room for one source.
    const match = /(?:\s*\[\s*\d{1,2}(?:\s*[,;]\s*\d{1,2})*\s*\])+\s*[.!?]?\s*$/.exec(text);
    if (!match) {
        // Mid-stream the citation arrives a character at a time, so the tail is
        // briefly a half-written "[1" — which would otherwise be painted onto
        // the glasses and then painted out again.
        return { body: text.replace(/(?:\s*\[[\d,;\s]*\])*\s*\[[\d,;\s]*$/, "").trim(), source: "" };
    }

    const first = /\d{1,2}/.exec(match[0]);
    const chunk = first ? chunks[Number(first[0]) - 1] : undefined;
    let body = text.slice(0, match.index).trim();
    // The sentence keeps its full stop when the citation took it away.
    if (body && !/[.!?…]$/.test(body)) body += ".";
    return {
        body,
        source: chunk ? `${chunk.doc} · с. ${chunk.page}` : "",
    };
}

/**
 * Transcribe, then answer in the background.
 *
 * Returns as soon as there is a question to show, because that is the first
 * thing the panel can honestly say and it arrives a second or two before the
 * answer does. The client opens the stream against the id it gets back.
 */
export async function ask(
    audio: Uint8Array,
    options: { device: string; sampleRate: number },
): Promise<{ id: string; question: string }> {
    sweep();

    if (!cfg.mistralKey) throw new Error("MISTRAL_API_KEY is not set");
    if (!cfg.geminiKey) throw new Error("GEMINI_API_KEY is not set");

    const seconds = audio.length / (options.sampleRate * 2);
    if (seconds < cfg.minSeconds) throw new Error("too_short");
    if (seconds > cfg.maxSeconds) throw new Error("too_long");

    const level = loudness(audio);
    if (level < SILENCE_FLOOR) {
        console.log(`[info] rejected ${seconds.toFixed(1)}s at level ${level.toFixed(0)} (silence)`);
        throw new Error("no_speech");
    }

    const question = forPanel(await transcribe(toWav(audio, options.sampleRate)));
    console.log(`[info] ${seconds.toFixed(1)}s @ ${level.toFixed(0)} -> ${question || "(nothing)"}`);
    if (!question) throw new Error("no_speech");

    const id = crypto.randomUUID().slice(0, 8);
    const run: Run = {
        id,
        question,
        lines: [],
        source: "",
        done: false,
        error: "",
        device: options.device,
        at: Date.now(),
        listeners: new Set(),
    };
    runs.set(id, run);

    void answer(run).catch((err) => {
        console.error("[info] answer failed:", err);
        // A quota refusal is the one failure here a person can do something
        // about — wait a moment and ask again — and it is the common one on a
        // free-tier key, where generate_content allows 20 requests a minute.
        // Reporting it as "the service is down" sends someone to check a server
        // that is fine.
        const message = String(err);
        run.error = /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(message)
            ? "Слишком много вопросов подряд"
            : "Сервис недоступен";
        run.done = true;
        notify(run);
    });

    return { id, question };
}

async function answer(run: Run): Promise<void> {
    const thread = threads.get(run.device);
    const history = thread ? thread.turns.slice(-cfg.threadTurns) : [];
    const previous = history.length ? history[history.length - 1].q : null;

    const chunks = await retrieve(run.question, previous);

    let raw = "";
    let shown = "";

    // The model emits its answer in a handful of deltas and the bridge write on
    // the other end costs a BLE round trip, so repainting per delta is both
    // pointless and slow. Coalesced to one repaint per PAINT_MS, plus a final
    // one when the stream ends.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const PAINT_MS = 150;

    const publish = () => {
        const { body } = splitSource(forPanel(raw), chunks);
        if (body === shown) return;
        shown = body;
        run.lines = body.split("\n").flatMap((line) => wrap(line));
        notify(run);
    };

    await streamAnswer(run.question, chunks, history, (delta) => {
        raw += delta;
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            publish();
        }, PAINT_MS);
    });

    if (timer) clearTimeout(timer);

    const { body, source } = splitSource(forPanel(raw), chunks);
    run.lines = body ? body.split("\n").flatMap((line) => wrap(line)) : [];
    // No source line when the model said the corpus does not cover it: there is
    // nothing to point at, and «В материалах этого нет · Соцсети с. 7» reads as
    // a page that failed rather than a question that was out of scope.
    run.source = run.lines.length && !/В материалах этого нет/i.test(body) ? source : "";
    if (!run.lines.length) run.error = "Пустой ответ";
    run.done = true;
    notify(run);

    // Recorded only once the answer is whole. A thread that remembers a turn
    // which failed halfway would carry a truncated sentence into the next
    // question's context as if the model had meant it.
    if (body && !run.error) {
        const turns = [...(thread?.turns ?? []), { q: run.question, a: body }];
        threads.set(run.device, {
            turns: turns.slice(-cfg.threadTurns),
            at: Date.now(),
        });
    }
}

/** Forget a device's thread — the client asks for this when it leaves the page. */
export function resetThread(device: string): void {
    threads.delete(device);
}

export function infoStatus() {
    return {
        ready: infoConfigured(),
        corpus: index ? { chunks: index.chunks.length, built: index.built } : null,
        stt: cfg.mistralKey ? cfg.sttModel : null,
        answer: cfg.geminiKey ? cfg.answerModels : null,
        embed: cfg.embedModel,
        topK: cfg.topK,
        maxSeconds: cfg.maxSeconds,
        threads: threads.size,
    };
}

/** How the description line reads at boot, next to the other subsystems'. */
export function description(): string {
    if (!cfg.mistralKey) return "Инфоблок: off (no MISTRAL_API_KEY)";
    if (!cfg.geminiKey) return "Инфоблок: off (no GEMINI_API_KEY)";
    if (!existsSync(cfg.index)) return `Инфоблок: off (no corpus at ${cfg.index})`;
    // The chain is printed in full: which rungs a deploy actually got is the
    // first thing to check when the page starts refusing after twenty questions.
    return `Инфоблок: ${cfg.sttModel} -> ${cfg.answerModels.join(" -> ")}, top ${cfg.topK}`;
}
