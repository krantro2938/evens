// Markdown (with TeX math) -> plain text, for the native TextContainer
// last-resort fallback (docPage.ts's showTextFallback). Same extract-math-
// first trick as the tile renderer's markdown.ts, but the output is a plain
// string rather than a DOM: headings/bold/lists just get their markdown
// syntax stripped instead of converted to tags, and there's no `marked`
// dependency to pull in for it.

import { texToReadable } from "./textMath";

const DISPLAY_MATH_RE = /\$\$([\s\S]+?)\$\$/g;
const INLINE_MATH_RE = /\$(?!\$)((?:\\.|[^$\\])+?)\$/g;

function extractMath(src: string): { text: string; spans: Map<string, string> } {
    const spans = new Map<string, string>();
    const token = () => `\x00MATH${spans.size}\x00`;

    let text = src.replace(DISPLAY_MATH_RE, (_m, tex) => {
        const t = token();
        spans.set(t, texToReadable(tex.trim()));
        return `\n\n${t}\n\n`;
    });
    text = text.replace(INLINE_MATH_RE, (_m, tex) => {
        const t = token();
        spans.set(t, texToReadable(tex.trim()));
        return t;
    });
    return { text, spans };
}

export function renderMarkdownToText(md: string): string {
    const { text, spans } = extractMath(md);

    let out = text
        .replace(/^#{1,3}\s+(.*)$/gm, "\n$1\n")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, "$1")
        .replace(/^[-*]\s+/gm, "- ");

    for (const [token, resolved] of spans) {
        out = out.split(token).join(resolved);
    }

    return out.replace(/\n{3,}/g, "\n\n").trim();
}
