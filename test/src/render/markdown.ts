// Markdown (with TeX math) -> HTML string.
//
// marked doesn't understand `$…$` / `$$…$$`, and running math through the
// markdown parser would let it mangle backslashes and underscores. So we
// pull the math out first, replace each span with an inert alphanumeric
// placeholder that marked passes through untouched, render the prose, then
// splice the rendered SVG back in.

import { marked } from "marked";
import { texToSvg } from "./math";

marked.setOptions({ gfm: true, breaks: false });

interface MathSpan {
    token: string;
    tex: string;
    display: boolean;
}

// Placeholder must survive markdown parsing verbatim: plain letters/digits,
// no punctuation marked might interpret.
function makeToken(i: number): string {
    return `zzmathspanzz${i}zzendzz`;
}

// Pull fenced/inline code out first so `$` inside code is never treated as
// math, then restore it after prose rendering.
function extractCode(src: string): { text: string; restore: (html: string) => string } {
    const blocks: string[] = [];
    const stash = (raw: string) => {
        const token = `zzcodezz${blocks.length}zzendzz`;
        blocks.push(raw);
        return token;
    };
    // Fenced blocks first, then inline spans.
    let text = src.replace(/```[\s\S]*?```/g, stash);
    text = text.replace(/`[^`\n]*`/g, stash);
    return {
        text,
        restore: (html) =>
            blocks.reduce((acc, raw, i) => acc.split(`zzcodezz${i}zzendzz`).join(raw), html),
    };
}

function extractMath(src: string): { text: string; spans: MathSpan[] } {
    const spans: MathSpan[] = [];
    const push = (tex: string, display: boolean) => {
        const token = makeToken(spans.length);
        spans.push({ token, tex: tex.trim(), display });
        return token;
    };

    // Display math ($$…$$) before inline ($…$) so the inline pass can't bite
    // into a `$$` delimiter.
    let text = src.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => `\n\n${push(tex, true)}\n\n`);
    text = text.replace(/\$(?!\$)((?:\\.|[^$\\])+?)\$/g, (_m, tex) => push(tex, false));
    return { text, spans };
}

export async function renderMarkdownToHtml(md: string): Promise<string> {
    const code = extractCode(md);
    const { text, spans } = extractMath(code.text);

    let html = await marked.parse(text);

    for (const span of spans) {
        const svg = texToSvg(span.tex, span.display);
        const wrapped = span.display
            ? `<div class="math-display">${svg}</div>`
            : `<span class="math-inline">${svg}</span>`;
        html = html.split(span.token).join(wrapped);
    }

    return code.restore(html);
}
