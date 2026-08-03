// The backup solver: this server solving the paper itself when no agent will.
//
// The solve loop has always had exactly two ways to be answered — the cloud
// routine a tap fires, and `routine/runner.sh` on a machine with a logged-in
// `claude` CLI — and both of them can be absent. The routine needs a repository
// selected and its egress opened to this host, the runner needs someone to have
// started it, and when neither is there a tap does nothing but say QUEUED. That
// is honest, and it is also a dead button.
//
// So: if a run goes unclaimed, this picks it up and solves it with Gemini.
//
// It deliberately goes through the SAME path as any other solver — claimRun()
// for the token, submitSolution() for the answer — rather than writing to the
// database directly. That means it inherits the whole concurrency story for
// free: tap again while it is working and its token is superseded, so its answer
// is refused on arrival exactly like a stale agent's. There is no second code
// path that could let two solvers both land an answer.
//
// It is a BACKUP, and the ordering is not an accident: an agent with tools that
// can check its own arithmetic is a better solver than one model call, so this
// only ever runs when the better option did not show up.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activeRun } from "./db";
import { claimRun, failRun, submitSolution } from "./solver";

const cfg = {
    key: process.env.GEMINI_API_KEY ?? "",
    // NOTE: this exact id is the one asked for. If Google answers 404 "model not
    // found", this env var is the single thing to change — nothing else here
    // depends on it. Known-good alternatives: gemini-2.5-flash, gemini-2.5-pro.
    model: process.env.BACKUP_SOLVER_MODEL ?? "gemini-3.6-flash",
    base: process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com",

    /**
     * How long an unclaimed run waits before this steps in.
     *
     * Two numbers, because "unclaimed" means different things. If the routine was
     * fired, a cloud session needs a minute or two just to boot and claim, and
     * cutting in front of it would spend a call to produce the worse of two
     * answers. If the trigger is unconfigured or failed, nothing is coming except
     * a runner someone may have left watching — so wait only long enough to let
     * that runner win, then solve.
     */
    afterTriggerMs: Number(process.env.BACKUP_SOLVER_DELAY_MS ?? 150_000),
    afterQueueMs: Number(process.env.BACKUP_SOLVER_QUEUE_DELAY_MS ?? 20_000),
};

export function isConfigured(): boolean {
    return Boolean(cfg.key);
}

export function description(): string {
    if (!isConfigured()) return "no backup solver (set GEMINI_API_KEY)";
    return `${cfg.model} after ${Math.round(cfg.afterTriggerMs / 1000)}s unclaimed`;
}

/**
 * The prompt, read from the repo rather than written here.
 *
 * `routine/solve-local.md` is what the CLI runner is given, and it is the same
 * job with the same output contract — including how to format for the panel and
 * how to write a ```viz figure. Reading it means there is one prompt to maintain
 * instead of three copies that drift, and a change to the figure spec reaches
 * this solver by being committed.
 */
let promptCache: string | null = null;
function solvePrompt(): string {
    if (promptCache !== null) return promptCache;
    for (const path of [
        join(import.meta.dir, "..", "routine", "solve-local.md"),
        join(process.cwd(), "..", "routine", "solve-local.md"),
    ]) {
        try {
            promptCache = readFileSync(path, "utf8").trim();
            return promptCache;
        } catch {
            // try the next one
        }
    }
    // Not fatal: a deployment whose image didn't ship routine/ can still solve,
    // it just does it with the short form of the same instructions.
    console.warn("[backup] routine/solve-local.md not found — using the built-in prompt");
    promptCache = [
        "Solve this assignment completely and correctly. Show the key step, the",
        "substitution and the result — not a lecture, not a bare answer.",
        "Write in the language of the assignment.",
        "Format for a 576x288 monochrome display: one `##` heading per problem,",
        "short lines, inline math as $…$ and display math as $$…$$ on its own line.",
        "End every problem with its result on its own line, bolded.",
        "Output only the markdown document, starting with the title as `#`.",
    ].join("\n");
    return promptCache;
}

/** Whatever a model wrapped the whole document in, unwrapped. */
function unwrap(text: string): string {
    const trimmed = text.trim();
    // `solve-local.md` says not to fence the document, so this only fires when
    // the instruction was ignored — but a solution rendered with three backticks
    // at the top is a page of literal backticks on the glasses.
    const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
    return (fenced ? fenced[1]! : trimmed).trim();
}

async function callGemini(assignment: string): Promise<string> {
    const res = await fetch(
        `${cfg.base}/v1beta/models/${cfg.model}:generateContent`,
        {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": cfg.key },
            body: JSON.stringify({
                contents: [
                    {
                        role: "user",
                        parts: [
                            {
                                text:
                                    `${solvePrompt()}\n\n` +
                                    `---\n\nTHE ASSIGNMENT (transcribed from the camera):\n\n${assignment}`,
                            },
                        ],
                    },
                ],
                generationConfig: {
                    // Low, not zero: this is working shown for a person to check,
                    // and zero on a long derivation is where models get stuck in
                    // a loop repeating a line.
                    temperature: 0.2,
                },
            }),
        },
    );
    const raw = await res.text();
    if (!res.ok) {
        // Verbatim, so a rejected model id shows up as the 404 it is.
        throw new Error(`Gemini ${res.status} (model="${cfg.model}"): ${raw.slice(0, 600)}`);
    }
    let body: any;
    try {
        body = JSON.parse(raw);
    } catch {
        throw new Error(`Gemini returned non-JSON: ${raw.slice(0, 400)}`);
    }
    const parts = body?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts)
        ? parts.map((p: any) => p?.text ?? "").join("")
        : parts?.[0]?.text;
    if (!text || !text.trim()) {
        throw new Error(
            `Gemini returned no content (finishReason=${body?.candidates?.[0]?.finishReason ?? "?"})`,
        );
    }
    return unwrap(text);
}

/** One solve at a time, and never twice for the same run. */
let solving = false;
const attempted = new Set<number>();

/**
 * Called from the solver's minute sweep. Claims and solves the live run if it
 * has been sitting unclaimed longer than the grace period for how it got there.
 *
 * Everything here is a reason NOT to solve, which is the right shape for
 * something that spends money: it acts only when a run is definitely waiting and
 * definitely nobody else's.
 */
export async function sweepBackup(): Promise<boolean> {
    if (!isConfigured() || solving) return false;

    const run = activeRun();
    // Nothing waiting, or an agent already has it — in which case the claimed
    // timeout in solver.ts is what resolves a run that dies mid-solve, not this.
    if (!run || run.state !== "pending") return false;
    if (attempted.has(run.id)) return false;

    const waited = Date.now() - run.created_at;
    const grace =
        run.trigger_state === "triggered" ? cfg.afterTriggerMs : cfg.afterQueueMs;
    if (waited < grace) return false;

    attempted.add(run.id);
    solving = true;
    console.log(
        `[backup] run ${run.id} unclaimed after ${Math.round(waited / 1000)}s ` +
            `(trigger: ${run.trigger_state ?? "none"}) — solving with ${cfg.model}`,
    );

    // claimRun() takes the next pending run, which is this one: creating a run
    // supersedes every earlier one, so there is only ever one to take.
    const claim = claimRun();
    if (!claim.ok || !claim.run_token) {
        solving = false;
        // An agent claimed it in the moment between the check and here. Its
        // answer is the one we wanted anyway.
        console.log(`[backup] stood down: ${claim.reason ?? "already claimed"}`);
        return false;
    }

    const started = Date.now();
    try {
        const markdown = await callGemini(claim.assignment?.markdown ?? "");
        // A whole document, even when this is a revision run: one model call
        // has no way to splice, and the submit path accepts either shape.
        const result = submitSolution(claim.run_token, {
            markdown,
            model: cfg.model,
            notes: "backup solver",
        });
        if (!result.ok) {
            // Superseded while it worked: someone tapped again, and this answer
            // is no longer wanted. Not an error.
            console.log(`[backup] answer refused: ${result.reason}`);
            return false;
        }
        console.log(
            `[backup] run ${claim.run_id} solved in ${Math.round((Date.now() - started) / 1000)}s ` +
                `(${markdown.length} chars, solution ${result.solution_id})`,
        );
        return true;
    } catch (err) {
        const message = String((err as Error)?.message ?? err).slice(0, 300);
        console.error(`[backup] run ${claim.run_id} failed: ${message}`);
        // Through failRun so the glasses show a reason rather than spinning until
        // the claimed timeout.
        failRun(claim.run_token, `backup solver: ${message}`);
        return true;
    } finally {
        solving = false;
    }
}

// Its own sweep rather than a hook in the solver's, so the primary path has no
// step that can be delayed or thrown out of by the backup. (solver.ts does
// import this, for the two strings the status feed reports — the cycle is
// function-level only, so both modules are initialised long before either calls
// into the other.)
//
// A sweep rather than a timer per run, because a sweep also covers the case a
// timer cannot: a restart with a run already waiting. Twice a minute — the grace
// periods are tens of seconds, so that is the resolution they get.
setInterval(() => {
    void sweepBackup().catch((err) => console.error("[backup] sweep failed:", err));
}, 30_000).unref?.();
