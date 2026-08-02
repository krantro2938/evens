// TeX -> HTML using KaTeX.
//
// KaTeX renders to HTML/CSS (not SVG), which html2canvas handles well. Much
// lighter than mathjax-full (~170KB vs ~1.5MB).

import katex from "katex";

export function texToHtml(tex: string, display: boolean): string {
    try {
        return katex.renderToString(tex, {
            displayMode: display,
            throwOnError: false,
            output: "html",
        });
    } catch (err) {
        console.error("texToHtml failed for:", tex, err);
        const safe = tex.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return `<span class="math-error">${safe}</span>`;
    }
}
