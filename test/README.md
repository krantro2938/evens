# Even Hub G2 app

Vite + TypeScript + SDK + CLI + simulator. A dashboard of tiles, plus two
document pages that show server-rendered PNG tiles pushed over BLE.

## Run

```bash
npm install
npm run dev
```

The document pages need the [document server](../server) running:

```bash
cd ../server && bun run start
```

Then either:
- **Simulator:** `npm run simulate`
- **Real glasses:** `npx evenhub qr --url http://<your-ip>:5173` and scan with the Even Hub companion app.

In dev, Vite proxies `/markdown`, `/tiles`, `/events` and `/assignment/*` to the
document server (`VITE_MD_TARGET`, default `http://192.168.0.117:8787`) so the
webview can open an EventSource same-origin. For a packed build set
`VITE_MD_SERVER` to the server's absolute URL instead.

## Pages

| Page | Shows | Gestures |
|---|---|---|
| Dashboard | the four menu tiles | swipe to move focus, tap to open |
| **AI** | `solution.md`, live | swipe/tap to page, double-tap back |
| **Assign** | what the [lookcam reader](../../lookcam/assignment) has transcribed off the paper, live | swipe to page, **tap to start/stop**, double-tap back |

Both document pages are instances of `src/docPage.ts` — same tile fetching,
paging, SSE-with-poll-fallback, per-tile dedup and text fallback. They differ
only in which endpoint they read and what a tap does.

The Assignment page adds a bordered box in the bottom-right corner. It is
always on screen (border width is part of the page definition, so a box that
came and went would force a full page rebuild and a re-push of all four tiles),
and shows the most useful thing available: the model's camera advice while a
capture job runs — `▲ move_down`, "The lower third of the sheet is out of
frame" — and otherwise what a tap will do (`Tap to start reading`, `Done · 4
problems`).

> The box overlaps the lower part of the bottom-right image tile, which assumes
> a text container draws **above** an image container. If your SDK build
> z-orders the other way, see the fallback noted at `FEEDBACK_Y` in
> `src/constants.ts` — it moves the box into the footer row instead.

## Pack for distribution

```bash
npm run pack
```

Produces an `.ehpk` file.

## What's in here

| File | Purpose |
|---|---|
| `index.html` | WebView host. Viewport meta tag locks zoom; CSS kills iOS double-tap zoom + rubber-band scroll. |
| `src/main.ts` | Bridge setup, page containers, the OS event subscription, navigation. |
| `src/dashboard.ts` | Menu focus + tap routing. |
| `src/docPage.ts` | Everything a document page does: tiles, paging, SSE, fallbacks. |
| `src/ai.ts` · `src/assignment.ts` | The two document pages — configuration over `docPage`. |
| `src/render/tiles.ts` | Fetch + decode the server's tiles; tile geometry. |
| `src/state.ts` · `src/constants.ts` | Global state; layout, container IDs, endpoints. |
| `src/debug.ts` | On-screen log panel (`appLog`). |
| `app.json` | Even Hub manifest. No permissions by default. |
| `vite.config.ts` | Dev server on 5173, LAN host binding, document-server proxy. |
