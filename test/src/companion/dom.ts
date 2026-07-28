// Just enough DOM helper to keep the tabs readable.
//
// No framework: this app already ships an SDK, a renderer and a document
// pipeline to a WebView on a phone, and four forms and a text area do not
// justify a fifth thing in the bundle.

type Attrs = Record<string, string | boolean | undefined> & {
    class?: string;
    text?: string;
};

export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Attrs = {},
    ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === false) continue;
        if (key === "text") node.textContent = String(value);
        else if (key === "class") node.className = String(value);
        else node.setAttribute(key, value === true ? "" : String(value));
    }
    node.append(...children);
    return node;
}

/**
 * A status line that says what happened, in one of three registers.
 *
 * Every tab here does something that can fail on a network or a phone-side
 * service, and "nothing visibly happened" is the worst possible report. So each
 * one owns one of these and every action ends by writing to it.
 */
export interface Status {
    node: HTMLElement;
    info: (text: string) => void;
    ok: (text: string) => void;
    error: (text: string) => void;
    clear: () => void;
}

export function status(): Status {
    const node = el("p", { class: "status" });
    const set = (kind: string, text: string) => {
        node.className = `status ${kind}`;
        node.textContent = text;
    };
    return {
        node,
        info: (text) => set("info", text),
        ok: (text) => set("ok", text),
        error: (text) => set("error", text),
        clear: () => set("", ""),
    };
}

/** Human-sized bytes, for a photo about to cross a phone's uplink. */
export function size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Copy text, with the fallback that actually matters here.
 *
 * navigator.clipboard needs a secure context, and this app is frequently served
 * over plain http from a laptop on the same wifi — where the modern API is not
 * merely blocked but absent, so a naive call throws on the property access.
 */
export async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        /* fall through to the textarea trick */
    }
    try {
        const area = el("textarea", { class: "offscreen" }) as HTMLTextAreaElement;
        area.value = text;
        document.body.append(area);
        area.select();
        const copied = document.execCommand("copy");
        area.remove();
        return copied;
    } catch {
        return false;
    }
}
