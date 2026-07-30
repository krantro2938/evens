// Markdown (with TeX math and ```viz figures) -> HTML string.
//
// marked doesn't understand `$…$` / `$$…$$`, and running math through the
// markdown parser would let it mangle backslashes and underscores. So we pull
// everything that must not be touched out first — fenced blocks, inline code,
// then math — replace each with an inert alphanumeric placeholder that marked
// passes through untouched, render the prose, and splice the rendered HTML back
// in.
//
// Order matters twice over: fences come out before math so a `$` inside a code
// or figure block is never read as a delimiter, and inline code comes out before
// math for the same reason.

import { marked } from "marked";
import { texToSvg } from "./math";
import { MAX_VIZ_PER_DOC, renderVizBlock, VIZ_LANGS } from "./viz";

marked.setOptions({ gfm: true, breaks: false });

interface Span {
    token: string;
    html: string;
    /**
     * Block-level HTML. marked wraps a lone placeholder in `<p>`, and a `<div>`
     * inside a `<p>` makes Chromium close the paragraph early and leave an empty
     * one behind — stray vertical space on a screen with 252 rows to spend. Block
     * spans get that wrapper stripped instead.
     */
    block: boolean;
}

// Placeholders must survive markdown parsing verbatim: plain letters/digits, no
// punctuation marked might interpret.
function makeToken(i: number): string {
    return `zzspanzz${i}zzendzz`;
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Pull out fenced blocks and inline code.
 *
 * A fence whose info string names a visualisation is rendered to SVG here (see
 * ./viz); every other fence becomes a real `<pre><code>`, which it did not used
 * to: the previous pass spliced the fence's *raw source* back into the finished
 * HTML, so a code block reached the glasses with its backticks showing and none
 * of the `pre` styling applied.
 */
function extractFences(src: string, spans: Span[]): string {
    let vizCount = 0;

    let text = src.replace(/```([^\n`]*)\r?\n([\s\S]*?)```/g, (_m, info: string, body: string) => {
        const lang = (info.trim().toLowerCase().split(/\s+/)[0] ?? "").replace(/^\{\.?|\}$/g, "");
        const token = makeToken(spans.length);

        if (VIZ_LANGS.has(lang)) {
            vizCount++;
            // The cap is a render-time ceiling: every figure is a fresh SVG the
            // headless browser has to lay out, and a document of nothing else
            // would hold the tile cache open long enough for the glasses to give
            // up on it.
            if (vizCount > MAX_VIZ_PER_DOC) {
                console.warn(`[viz] over the per-document cap of ${MAX_VIZ_PER_DOC}; skipped`);
                spans.push({ token, html: "", block: true });
            } else {
                spans.push({ token, html: renderVizBlock(body, lang).html, block: true });
            }
            return `\n\n${token}\n\n`;
        }

        spans.push({
            token,
            html: `<pre><code>${escapeHtml(body.replace(/\n$/, ""))}</code></pre>`,
            block: true,
        });
        return `\n\n${token}\n\n`;
    });

    text = text.replace(/`([^`\n]*)`/g, (_m, body: string) => {
        const token = makeToken(spans.length);
        spans.push({ token, html: `<code>${escapeHtml(body)}</code>`, block: false });
        return token;
    });

    return text;
}

function extractMath(src: string, spans: Span[]): string {
    const push = (tex: string, display: boolean): string => {
        const token = makeToken(spans.length);
        const svg = texToSvg(tex.trim(), display);
        spans.push({
            token,
            html: display
                ? `<div class="math-display">${svg}</div>`
                : `<span class="math-inline">${svg}</span>`,
            block: display,
        });
        return token;
    };

    // Display math ($$…$$) before inline ($…$) so the inline pass can't bite
    // into a `$$` delimiter.
    let text = src.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => `\n\n${push(tex, true)}\n\n`);
    text = text.replace(/\$(?!\$)((?:\\.|[^$\\])+?)\$/g, (_m, tex) => push(tex, false));
    return text;
}

export async function renderMarkdownToHtml(md: string): Promise<string> {
    const spans: Span[] = [];
    const text = extractMath(extractFences(md, spans), spans);

    let html = await marked.parse(text);

    for (const span of spans) {
        if (span.block) {
            html = html.split(`<p>${span.token}</p>`).join(span.html);
        }
        html = html.split(span.token).join(span.html);
    }

    return html;
}
