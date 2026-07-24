// TeX -> SVG using mathjax-full's liteAdaptor.
//
// liteAdaptor is a self-contained DOM shim, so this runs in the WebView with
// no browser-DOM or Node dependency, and the SVG it emits uses <path> glyphs
// (fontCache: 'local' keeps each formula's glyph <defs> inside its own <svg>),
// so every formula is standalone and rasterizes cleanly with html2canvas.
//
// The <svg> keeps its intrinsic width/height in `ex` units and a
// `vertical-align` style, so when injected inline it scales and sits on the
// baseline relative to the surrounding font. Glyphs fill with `currentColor`,
// so the color is inherited from the container's CSS `color`.

import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";

type Converter = (tex: string, display: boolean) => string;

let converter: Converter | null = null;

function getConverter(): Converter {
    if (converter) return converter;

    const adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);

    const input = new TeX({ packages: AllPackages });
    const output = new SVG({ fontCache: "local" });
    const doc = mathjax.document("", {
        InputJax: input,
        OutputJax: output,
    });

    converter = (tex, display) => {
        const node = doc.convert(tex, { display });
        // innerHTML of the mjx-container is just the <svg>…</svg>.
        return adaptor.innerHTML(node);
    };
    return converter;
}

/** Render a TeX string to a standalone inline `<svg>` string. */
export function texToSvg(tex: string, display: boolean): string {
    try {
        return getConverter()(tex, display);
    } catch (err) {
        console.error("texToSvg failed for:", tex, err);
        // Fall back to showing the raw TeX so the page still renders.
        const safe = tex.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return `<span class="math-error">${safe}</span>`;
    }
}
