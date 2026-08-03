// Turning the site's HTML into a tree this packer can reason about.
//
// Parsed by a real browser rather than by regex, for three reasons that all
// showed up in the source within the first article:
//
//   - The markup is not well-formed. <p> wraps <ul>, <li> elements are left
//     unclosed, and <sup> is nested inside <sup> as a visual hack. Every parser
//     recovers from that differently; Chromium recovers from it the way the
//     page was authored and checked in, which is the only interpretation that
//     matches what a reader sees.
//   - Entities decode themselves. The formulas are written &radic;, &pi;,
//     &phi;, &infin;, &nbsp; — a browser hands back √ π φ ∞, so there is no
//     entity table here to fall behind the source.
//   - Playwright is already a dependency of the renderer this packer reuses, so
//     it costs nothing.
//
// The walker deliberately emits a dumb normalized tree and nothing more. All
// the judgement — what is a fraction, what is a figure, what is a superscript
// pretending to be one — happens in convert.ts, where it can be unit-tested
// without a browser.

import { chromium, type Browser } from "playwright";

export type Node =
    | { t: "text"; v: string }
    | {
          t: "el";
          tag: string;
          /** class attribute, lowercased; "" when absent. */
          cls: string;
          kids: Node[];
          /** <img> only. */
          src?: string;
          alt?: string;
      };

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
    if (!browser) browser = await chromium.launch();
    return browser;
}

export async function closeDom(): Promise<void> {
    await browser?.close();
    browser = null;
}

/**
 * Parse an article and return the normalized tree of its <main>.
 *
 * Everything outside <main> is site chrome — the top menu, the stylesheet
 * links, the comment form — and is dropped here rather than filtered later,
 * because chrome that reaches convert.ts looks exactly like content.
 */
export async function parseMain(html: string): Promise<Node[]> {
    const b = await getBrowser();
    const page = await b.newPage();
    try {
        await page.setContent(html, { waitUntil: "domcontentloaded" });
        return (await page.evaluate(() => {
            // Elements that are chrome or invisible. `visibility: hidden`
            // matters more than it looks: the author reserves vertical space
            // with hidden empty <table class="fraction"> elements so lines
            // don't jump as formulas load, and there are ~100 of them across
            // the course. Kept, each one becomes a stray empty fraction.
            const DROP = new Set(["SCRIPT", "STYLE", "NAV", "HEADER", "FOOTER", "FORM", "NOSCRIPT"]);

            function hidden(el: Element): boolean {
                const style = el.getAttribute("style") ?? "";
                if (/visibility:\s*hidden|display:\s*none/i.test(style)) return true;
                // The comment widget is a <table class='comments'>, not a form.
                return (el.getAttribute("class") ?? "").split(/\s+/).includes("comments");
            }

            function walk(node: ChildNode): unknown | null {
                if (node.nodeType === 3) {
                    const v = node.nodeValue ?? "";
                    return v.trim() === "" && !/[  ]/.test(v) ? null : { t: "text", v };
                }
                if (node.nodeType !== 1) return null;
                const el = node as Element;
                if (DROP.has(el.tagName) || hidden(el)) return null;

                const out: Record<string, unknown> = {
                    t: "el",
                    tag: el.tagName.toLowerCase(),
                    cls: (el.getAttribute("class") ?? "").toLowerCase(),
                    kids: [...el.childNodes].map(walk).filter(Boolean),
                };
                if (el.tagName === "IMG") {
                    out.src = el.getAttribute("src") ?? "";
                    out.alt = el.getAttribute("alt") ?? "";
                }
                return out;
            }

            const main = document.querySelector("main") ?? document.body;
            return [...main.childNodes].map(walk).filter(Boolean);
        })) as Node[];
    } finally {
        await page.close();
    }
}
