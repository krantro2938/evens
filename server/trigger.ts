// Kicks the Claude routine that does the actual solving.
//
// A routine (claude.ai → Code → Routines) is a saved Claude Code cloud session:
// a prompt, a repo, an environment. Give it an **API trigger** and it gets its
// own endpoint and bearer token, which is all this module needs:
//
//   POST https://api.anthropic.com/v1/claude_code/routines/<id>/fire
//        authorization: Bearer sk-ant-oat01-…      (per-routine, from the web UI)
//        anthropic-beta: experimental-cc-routine-2026-04-01
//        anthropic-version: 2023-06-01
//        {"text": "…"}                             (optional run context)
//
// The token is scoped to firing this one routine — it can't read your account or
// spend anything else — so unlike an OAuth session credential it is a reasonable
// thing to keep in a .env on a VPS. Rotate it in the same modal that made it.
//
// The response carries the new session's URL, which is worth keeping: it is
// where you watch the run, and where a failure explains itself.
//
// TWO THINGS THE ROUTINE NEEDS, or a fire that returns 200 still does nothing:
//
//   - a repository. A routine with no repo produces no session at all.
//   - network access to this server. A cloud environment defaults to "Trusted",
//     which allows the package registries and blocks everything else; an
//     outbound request to anything else fails with 403 and
//     `x-deny-reason: host_not_allowed`. Set the environment's Network access to
//     Custom and add this server's domain, or the routine cannot claim work.
//
// Without ROUTINE_ID/ROUTINE_TOKEN the trigger is simply absent and every run is
// queued for whatever else drains it (routine/runner.sh, or the routine's own
// schedule). That is a working configuration, not an error.
//
// TWO ROUTINES, not one. The solver writes the answer; the reviewer grades it
// and decides what goes back for another attempt (see review.ts). They are
// separate routines rather than one prompt with a mode flag because they are
// separate jobs with separate costs: the solver can be Sonnet on an easy paper
// while the reviewer stays Opus, and a routine's model is a property of the
// routine. Each therefore has its own id and its own fire token, and each is
// independently absent-able — no reviewer configured just means solutions are
// never graded, which is how this server behaved before the review loop existed.

const ROUTINE_ID = process.env.ROUTINE_ID ?? "";
const ROUTINE_TOKEN = process.env.ROUTINE_TOKEN ?? "";

/** The reviewer. Falls back to the solver's token when only the id differs —
 *  one API trigger can be reused across two routines in the same account. */
const REVIEW_ROUTINE_ID = process.env.REVIEW_ROUTINE_ID ?? "";
const REVIEW_ROUTINE_TOKEN = process.env.REVIEW_ROUTINE_TOKEN ?? ROUTINE_TOKEN;

const API_BASE = (
  process.env.ROUTINE_API ?? "https://api.anthropic.com"
).replace(/\/+$/, "");
/** Research-preview header the /fire endpoint ships under. */
const ROUTINE_BETA =
  process.env.ROUTINE_BETA ?? "experimental-cc-routine-2026-04-01";
/** Required on every api.anthropic.com call — omitting it is a 400, not a default. */
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION ?? "2023-06-01";

const FIRE_TIMEOUT_MS = 20_000;

export interface TriggerResult {
  /** `triggered` — a session is starting. Anything else: the run stays queued. */
  state: "triggered" | "unconfigured" | "failed";
  /** The session URL on success, so the run can be watched; the error otherwise. */
  detail: string | null;
}

export function isConfigured(): boolean {
  return ROUTINE_ID !== "" && ROUTINE_TOKEN !== "";
}

export function reviewConfigured(): boolean {
  return REVIEW_ROUTINE_ID !== "" && REVIEW_ROUTINE_TOKEN !== "";
}

/** What the status feed reports, so the glasses can explain a queued run. */
export function triggerDescription(): string {
  if (!ROUTINE_ID) return "no ROUTINE_ID";
  if (!ROUTINE_TOKEN) return "no ROUTINE_TOKEN";
  return ROUTINE_ID;
}

export function reviewTriggerDescription(): string {
  if (!REVIEW_ROUTINE_ID) return "no REVIEW_ROUTINE_ID";
  if (!REVIEW_ROUTINE_TOKEN) return "no REVIEW_ROUTINE_TOKEN";
  return REVIEW_ROUTINE_ID;
}

/**
 * Start a routine now. Never throws: the caller has already recorded the run,
 * and a queued run is a working outcome — something else will drain it.
 *
 * `text` is optional run context. It reaches the session wrapped in a
 * `<routine-fire-payload>` block explicitly labelled untrusted, which is exactly
 * right here: it says which run is waiting, and the routine's prompt gets the
 * work itself from /solution/claim rather than from anything we send.
 */
async function fire(
  id: string,
  token: string,
  describe: () => string,
  text?: string,
): Promise<TriggerResult> {
  if (!id || !token) return { state: "unconfigured", detail: describe() };

  try {
    const res = await fetch(
      `${API_BASE}/v1/claude_code/routines/${id}/fire`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-beta": ROUTINE_BETA,
          "content-type": "application/json",
        },
        body: JSON.stringify(text ? { text } : {}),
        signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
      },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // 401 here is the token, not the account: it is per-routine and revocable,
      // so the fix is to regenerate it in the routine's API-trigger modal.
      return {
        state: "failed",
        detail: `fire HTTP ${res.status} ${body.slice(0, 200)}`.trim(),
      };
    }

    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const url = typeof json.claude_code_session_url === "string"
      ? json.claude_code_session_url
      : id;
    return { state: "triggered", detail: url };
  } catch (err) {
    return {
      state: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Kick the solver. */
export const runRoutine = (text?: string): Promise<TriggerResult> =>
  fire(ROUTINE_ID, ROUTINE_TOKEN, triggerDescription, text);

/** Kick the reviewer. Same contract, different routine — see the note above. */
export const runReviewRoutine = (text?: string): Promise<TriggerResult> =>
  fire(REVIEW_ROUTINE_ID, REVIEW_ROUTINE_TOKEN, reviewTriggerDescription, text);

export { ROUTINE_ID, REVIEW_ROUTINE_ID };
