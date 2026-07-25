// CSS for the offscreen render root. The panel is 576px wide, 4-bit greyscale
// green-on-black — so we render light-on-dark, high contrast, at a generous
// size for legibility, and let the SDK map white→green during PNG→gray4.
//
// Math <svg> glyphs fill with `currentColor`, so `color:#fff` here makes them
// white (→ green on glass).

export const RENDER_WIDTH = 576;

export const RENDER_CSS = `
.md-root {
  box-sizing: border-box;
  width: ${RENDER_WIDTH}px;
  padding: 12px 16px;
  margin: 0;
  background: #000;
  color: #fff;
  font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 21px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
  word-wrap: break-word;
  overflow-wrap: break-word;
}
.md-root * { box-sizing: border-box; }
.md-root h1 { font-size: 26px; font-weight: 700; margin: 0 0 12px; line-height: 1.2; }
.md-root h2 { font-size: 23px; font-weight: 700; margin: 18px 0 8px; line-height: 1.25; }
.md-root h3 { font-size: 21px; font-weight: 700; margin: 14px 0 6px; }
.md-root p { margin: 8px 0; }
.md-root ul, .md-root ol { margin: 8px 0; padding-left: 24px; }
.md-root li { margin: 4px 0; }
.md-root strong { font-weight: 700; }
.md-root em { font-style: italic; }
.md-root code {
  font-family: "SF Mono", "Menlo", "Consolas", monospace;
  font-size: 0.9em;
  background: #222;
  padding: 1px 4px;
  border-radius: 3px;
}
.md-root pre {
  background: #161616;
  padding: 8px 10px;
  border-radius: 4px;
  overflow-x: auto;
}
.md-root pre code { background: none; padding: 0; }
.md-root blockquote {
  margin: 8px 0;
  padding-left: 12px;
  border-left: 3px solid #555;
  color: #d0d0d0;
}
.md-root hr { border: none; border-top: 1px solid #444; margin: 14px 0; }
.md-root a { color: #fff; text-decoration: underline; }
.md-root .math-inline { display: inline-block; }
.md-root .math-inline svg { vertical-align: -0.25ex; }
.md-root .math-display {
  display: block;
  text-align: center;
  overflow-x: hidden;
  margin: 12px 0;
}
.md-root .math-display svg { max-width: 100%; }
.md-root .math-error { color: #ff9b9b; font-family: monospace; font-size: 0.9em; }
.md-root svg { color: #fff; fill: currentColor; }
`;
