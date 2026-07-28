// The phone's camera roll, and publishing one of its photos as the assignment.
//
// WHY THERE IS A BRIDGE AT ALL. This app is a web page, and a web page cannot
// read a gallery — the most it can do is open a file picker, which means
// picking the phone up and tapping twice. That is acceptable in the companion
// app, where you are already holding the phone, and useless on the glasses,
// where the entire point is not to.
//
// So the phone runs a tiny HTTP server (evens/phone/gallery.py, under Termux)
// that serves its newest photos on localhost. This app runs ON that phone, so
// it can simply fetch it: browsers treat http://127.0.0.1 as a secure origin,
// which is what lets an https page talk to it without a mixed-content block.
//
// Both consumers live here rather than in the page that uses them, because the
// companion app and the glasses Settings page must agree on which photo "the
// latest" is — they are the same web app on the same phone, so they share the
// configured bridge and this module's idea of what it returns.

import { MARKDOWN_SERVER_URL } from "./constants";

/** Where the bridge is, as pasted from the script's own startup output. */
const STORAGE_KEY = "evens.gallery.bridge";

export interface PhotoMeta {
    id: string;
    name: string;
    mime: string;
    bytes: number;
    /** ms since epoch, from the file's mtime — when the photo was taken. */
    taken_at: number;
}

/**
 * The configured bridge, split into the parts a request needs.
 *
 * Stored as one string (`http://127.0.0.1:8790?t=TOKEN`) because that is what
 * the script prints and what you paste — one field to fill in, and no way to
 * pair the wrong token with the wrong host.
 */
export interface Bridge {
    base: string;
    token: string;
}

export function getBridge(): Bridge | null {
    const raw = readStored();
    if (!raw) return null;
    try {
        const url = new URL(raw);
        const token = url.searchParams.get("t") ?? "";
        return { base: `${url.origin}${url.pathname.replace(/\/$/, "")}`, token };
    } catch {
        return null;
    }
}

export function setBridge(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed) {
        writeStored("");
        return true;
    }
    try {
        new URL(trimmed);
    } catch {
        return false;
    }
    writeStored(trimmed);
    return true;
}

export function bridgeUrl(): string {
    return readStored();
}

// localStorage is unavailable in some WebViews (and throws rather than
// returning null), and a settings field is not worth taking the app down for.
function readStored(): string {
    try {
        return localStorage.getItem(STORAGE_KEY) ?? "";
    } catch {
        return "";
    }
}

function writeStored(value: string): void {
    try {
        if (value) localStorage.setItem(STORAGE_KEY, value);
        else localStorage.removeItem(STORAGE_KEY);
    } catch {
        /* nothing to do: the field simply won't persist */
    }
}

function withToken(bridge: Bridge, path: string): string {
    // The token goes in the query rather than a header so the same URL works as
    // an <img src> — showing the photo you are about to publish matters more
    // than the tidiness of an Authorization header.
    const join = path.includes("?") ? "&" : "?";
    return `${bridge.base}${path}${bridge.token ? `${join}t=${encodeURIComponent(bridge.token)}` : ""}`;
}

/** A bridge that is unreachable is the normal case (Termux not running). */
const BRIDGE_TIMEOUT_MS = 4_000;

async function bridgeFetch(path: string): Promise<Response> {
    const bridge = getBridge();
    if (!bridge) throw new Error("no gallery bridge configured");
    const res = await fetch(withToken(bridge, path), {
        signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
    });
    if (res.status === 401) throw new Error("bridge rejected the token");
    if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `bridge HTTP ${res.status}`);
    }
    return res;
}

export interface BridgeHealth {
    ok: boolean;
    roots: string[];
    detail?: string;
}

export async function checkBridge(): Promise<BridgeHealth> {
    try {
        const res = await bridgeFetch("/health");
        const body = (await res.json()) as { roots?: string[] };
        return { ok: true, roots: body.roots ?? [] };
    } catch (err) {
        return {
            ok: false,
            roots: [],
            detail: err instanceof Error ? err.message : String(err),
        };
    }
}

/** Metadata only — cheap enough to poll, and enough to name the photo. */
export async function latestPhoto(): Promise<PhotoMeta> {
    return (await bridgeFetch("/latest.json")).json() as Promise<PhotoMeta>;
}

export async function recentPhotos(limit = 12): Promise<PhotoMeta[]> {
    const body = (await bridgeFetch(`/recent.json?n=${limit}`)).json() as Promise<{
        photos?: PhotoMeta[];
    }>;
    return (await body).photos ?? [];
}

/**
 * The bytes of one photo, by the id a listing gave for it.
 *
 * There is deliberately no "give me the bytes of the latest" helper, even
 * though the bridge offers the route. Every caller here shows you which photo
 * it is about before acting on it, and fetching "the latest" a second time
 * after that is how the name on screen and the bytes on the wire come apart.
 */
export async function photoBlob(id: string): Promise<Blob> {
    return (await bridgeFetch(`/photo?id=${encodeURIComponent(id)}`)).blob();
}

/** A URL an <img> can load directly, or null when nothing is configured. */
export function photoSrc(id: string): string | null {
    const bridge = getBridge();
    return bridge ? withToken(bridge, `/photo?id=${encodeURIComponent(id)}`) : null;
}

// ── publishing ──────────────────────────────────────────────────────────────

export interface PublishResult {
    ok: boolean;
    detail?: string;
    version?: number;
    problems?: number;
    done?: boolean;
}

/**
 * Send a photo to the document server, which forwards it to the reader.
 *
 * THIS REPLACES THE ASSIGNMENT. The reader archives the current attempt and
 * reads the photo as a fresh one, because a photo is a different sheet — see
 * publishPhoto in server/assignment.ts. Every caller should have said so before
 * getting here; the glasses page makes you tap twice for exactly this reason.
 */
export async function publishPhoto(photo: Blob, name?: string): Promise<PublishResult> {
    const query = name ? `?name=${encodeURIComponent(name)}` : "";
    try {
        const res = await fetch(`${MARKDOWN_SERVER_URL}/assignment/photo${query}`, {
            method: "POST",
            // The body IS the image: the server reads the type from this header.
            headers: { "content-type": photo.type || "image/jpeg" },
            body: photo,
            // A Gemini read of a phone-sized photo is slow, and the server's own
            // timeout is the one that should decide this, not the browser's.
            signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
        });
        const body = (await res.json().catch(() => ({}))) as PublishResult;
        if (!res.ok) return { ok: false, detail: body.detail ?? `HTTP ${res.status}` };
        return body;
    } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
}

const PUBLISH_TIMEOUT_MS = 150_000;

/**
 * Shoot, then publish, without touching the phone. The Setup page's verb.
 *
 * Fetched BY ID rather than by asking for "the latest" twice. The Setup page
 * names the photo before you confirm, and there are two round trips between
 * that name and these bytes — long enough to take another picture. Asking for
 * the latest again would then publish a photo you were never shown, which is
 * the one mistake a confirmation step exists to make impossible.
 */
export async function publishLatestFromGallery(known?: PhotoMeta): Promise<PublishResult> {
    try {
        const meta = known ?? (await latestPhoto());
        return await publishPhoto(await photoBlob(meta.id), meta.name);
    } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
}
