// Kicks the Claude routine that does the actual solving.
//
// A routine (claude.ai → Code → Routines) is a cloud Claude Code session. It
// normally fires on a cron, but it can also be run on demand:
//
//   POST https://api.anthropic.com/v1/code/triggers/<id>/run
//
// which is what a tap on the glasses ends up doing. That endpoint authenticates
// with a **claude.ai OAuth token** — the credential `claude /login` writes to
// ~/.claude/.credentials.json — not with an ANTHROPIC_API_KEY. So to trigger
// from the VPS, a copy of those tokens has to live here, and this module owns
// refreshing them when they expire (the access token lasts hours; the refresh
// token rotates on use and is written back).
//
// Two things follow from that, and both are handled rather than assumed away:
//
//   - This is not a documented public API. Endpoint, header and client id can
//     change under us. Every failure path therefore leaves the run queued
//     instead of losing it: the routine's own hourly cron drains the queue, so
//     a broken trigger degrades from "instant" to "within the hour" rather than
//     to "nothing happens". The glasses say which one you got.
//   - Without CLAUDE_TRIGGER_ID (or with no credentials) the trigger is simply
//     absent and every run is queued. That is the default, and it is a working
//     configuration — not an error.

import { chmodSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DATA_DIR } from "./db";

const TRIGGER_ID = process.env.CLAUDE_TRIGGER_ID ?? "";
const API_BASE = (
  process.env.CLAUDE_TRIGGER_API ?? "https://api.anthropic.com"
).replace(/\/+$/, "");
/** The beta header the CLI sends on these routes; without it the API 404s. */
const TRIGGER_BETA = process.env.CLAUDE_TRIGGER_BETA ?? "ccr-triggers-2026-01-30";
/** Required on every api.anthropic.com call — omitting it is a 400, not a default. */
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION ?? "2023-06-01";

const TOKEN_URL =
  process.env.CLAUDE_OAUTH_TOKEN_URL ??
  "https://console.anthropic.com/v1/oauth/token";
/** Claude Code's public OAuth client id — the one the local CLI refreshes with. */
const CLIENT_ID =
  process.env.CLAUDE_OAUTH_CLIENT_ID ?? "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const CREDENTIALS_PATH =
  process.env.CLAUDE_OAUTH_FILE ?? resolve(DATA_DIR, "claude-oauth.json");

/** Refresh this far ahead of expiry rather than waiting for a 401. */
const REFRESH_SKEW_MS = 60_000;

export interface TriggerResult {
  /** `triggered` — the routine is starting. Anything else: the run is queued. */
  state: "triggered" | "unconfigured" | "failed";
  detail: string | null;
}

interface Credentials {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms. 0 when unknown — then we refresh only after a 401. */
  expiresAt: number;
  /** True when the file used the CLI's `{claudeAiOauth:{…}}` shape. */
  nested: boolean;
}

// ── credentials ─────────────────────────────────────────────────────────────

/**
 * Env vars win, so a deployment can inject tokens without a mounted file — but
 * then there is nowhere to write a rotated refresh token, so the file is the
 * configuration we document.
 */
function loadCredentials(): Credentials | null {
  const envAccess = process.env.CLAUDE_OAUTH_ACCESS_TOKEN;
  if (envAccess) {
    return {
      accessToken: envAccess,
      refreshToken: process.env.CLAUDE_OAUTH_REFRESH_TOKEN ?? null,
      expiresAt: Number(process.env.CLAUDE_OAUTH_EXPIRES_AT ?? 0),
      nested: false,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(CREDENTIALS_PATH, "utf8");
  } catch {
    return null; // absent is the default configuration, not a failure
  }
  try {
    const json = JSON.parse(raw) as Record<string, any>;
    // Accept the CLI's own file verbatim, so "copy your ~/.claude
    // /.credentials.json onto the VPS" is the whole setup step.
    const nested = Boolean(json.claudeAiOauth);
    const o = nested ? json.claudeAiOauth : json;
    if (!o?.accessToken) return null;
    return {
      accessToken: String(o.accessToken),
      refreshToken: o.refreshToken ? String(o.refreshToken) : null,
      expiresAt: Number(o.expiresAt ?? 0),
      nested,
    };
  } catch (err) {
    console.error("[trigger] credentials file is not JSON:", err);
    return null;
  }
}

/** Write rotated tokens back, atomically, 0600. Losing this write costs the
 *  next refresh (the old refresh token is spent), so it happens before use. */
async function saveCredentials(c: Credentials): Promise<void> {
  if (process.env.CLAUDE_OAUTH_ACCESS_TOKEN) return; // env-configured: nothing to write
  const payload = {
    accessToken: c.accessToken,
    refreshToken: c.refreshToken,
    expiresAt: c.expiresAt,
  };
  const body = JSON.stringify(
    c.nested ? { claudeAiOauth: payload } : payload,
    null,
    2,
  );
  const tmp = `${CREDENTIALS_PATH}.tmp`;
  await writeFile(tmp, body);
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // A filesystem without modes (a bind mount on some hosts) is not a reason
    // to fail the write.
  }
  // Temp-file + rename: a crash mid-write can't leave a truncated credential
  // file, which would cost the refresh token and so the trigger.
  await rename(tmp, CREDENTIALS_PATH);
}

/** Exchange the refresh token for a new access token, and persist the rotation. */
async function refresh(c: Credentials): Promise<Credentials> {
  if (!c.refreshToken) throw new Error("no refresh token to refresh with");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: c.refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`refresh HTTP ${res.status} ${text.slice(0, 200)}`.trim());
  }
  const json = (await res.json()) as Record<string, any>;
  if (!json.access_token) throw new Error("refresh returned no access_token");

  const next: Credentials = {
    accessToken: String(json.access_token),
    // The rotation: the response's refresh token replaces the one we just
    // spent. Keeping the old one would work exactly once more.
    refreshToken: json.refresh_token ? String(json.refresh_token) : c.refreshToken,
    expiresAt: json.expires_in
      ? Date.now() + Number(json.expires_in) * 1000
      : 0,
    nested: c.nested,
  };
  await saveCredentials(next);
  console.log("[trigger] refreshed claude.ai OAuth token");
  return next;
}

// ── the call ────────────────────────────────────────────────────────────────

export function isConfigured(): boolean {
  return TRIGGER_ID !== "" && loadCredentials() !== null;
}

/** What the status feed reports, so the glasses can explain a queued run. */
export function triggerDescription(): string {
  if (!TRIGGER_ID) return "no CLAUDE_TRIGGER_ID";
  if (!loadCredentials()) return "no claude.ai credentials";
  return TRIGGER_ID;
}

async function runOnce(token: string): Promise<Response> {
  return fetch(`${API_BASE}/v1/code/triggers/${TRIGGER_ID}/run`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": TRIGGER_BETA,
      "content-type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(20_000),
  });
}

/**
 * Start the routine now. Never throws: the caller has already recorded the run,
 * and a queued run is a working outcome — the routine's cron will find it.
 */
export async function runRoutine(): Promise<TriggerResult> {
  if (!TRIGGER_ID) return { state: "unconfigured", detail: "no CLAUDE_TRIGGER_ID" };

  let creds = loadCredentials();
  if (!creds) {
    return {
      state: "unconfigured",
      detail: `no credentials at ${CREDENTIALS_PATH}`,
    };
  }

  try {
    if (creds.expiresAt && creds.expiresAt - Date.now() < REFRESH_SKEW_MS) {
      creds = await refresh(creds);
    }

    let res = await runOnce(creds.accessToken);
    // Expiry we didn't predict (clock skew, a token revoked early): one retry
    // after a refresh, then give up and let the run sit in the queue.
    if (res.status === 401 && creds.refreshToken) {
      creds = await refresh(creds);
      res = await runOnce(creds.accessToken);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        state: "failed",
        detail: `run HTTP ${res.status} ${text.slice(0, 200)}`.trim(),
      };
    }
    return { state: "triggered", detail: TRIGGER_ID };
  } catch (err) {
    return {
      state: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export { CREDENTIALS_PATH, TRIGGER_ID };
