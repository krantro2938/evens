// Markdown (with TeX math) -> HTML string.
//
// marked doesn't understand `$…$` / `$$…$$`, and running math through the
// markdown parser would let it mangle backslashes and underscores. So we
// pull the math out first, replace each span with an inert alphanumeric
// placeholder that marked passes through untouched, render the prose, then
// splice the KaTeX HTML back in.

import { marked } from "marked";
import { texToHtml } from "./math";
import katexCss from "katex/dist/katex.min.css?inline";

marked.setOptions({ gfm: true, breaks: false });

interface MathSpan {
    token: string;
    tex: string;
    display: boolean;
}

function makeToken(i: number): string {
    return `zzmathspanzz${i}zzendzz`;
}

function extractCode(src: string): { text: string; restore: (html: string) => string } {
    const blocks: string[] = [];
    const stash = (raw: string) => {
        const token = `zzcodezz${blocks.length}zzendzz`;
        blocks.push(raw);
        return token;
    };
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

    let text = src.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => `\n\n${push(tex, true)}\n\n`);
    text = text.replace(/\$(?!\$)((?:\\.|[^$\\])+?)\$/g, (_m, tex) => push(tex, false));
    return { text, spans };
}

export async function renderMarkdownToHtml(md: string): Promise<string> {
    const code = extractCode(md);
    const { text, spans } = extractMath(code.text);

    let html = await marked.parse(text);

    for (const span of spans) {
        const rendered = texToHtml(span.tex, span.display);
        html = html.split(span.token).join(rendered);
    }

    return `<style>${katexCss}</style>${code.restore(html)}`;
}
