# Even Hub G2 app

Vite + TypeScript + SDK + CLI + simulator. A dashboard of tiles, plus two
document pages that show server-rendered PNG tiles pushed over BLE.

## Run

```bash
npm install
npm run dev          # against the deployed server on the VPS
```

Then either:
- **Simulator:** `npm run simulate`
- **Real glasses:** `npx evenhub qr --url http://<your-ip>:5173` and scan with the Even Hub companion app.

That's the whole setup — `npm run dev` needs nothing running locally, because it
points at the deployed document server by default.

## Configuration

**There is one thing to configure: which document server to talk to.** Every
route the app fetches — `/markdown`, `/tiles`, `/events`, `/assignment/*` — is
served by that single origin. The [lookcam assignment reader](../../lookcam/assignment)
is reached *by the document server*, so its URL and token are never set here.

| Variable | Used by | Meaning |
|---|---|---|
| `VITE_MD_TARGET` | `npm run dev` | Where Vite proxies the document routes. Default `https://even.aansl.com`. |
| `VITE_MD_SERVER` | packed build | Absolute URL compiled into the bundle. Leave unset in dev — unset means same-origin, which is what the proxy provides. |

Set them in `.env.local` (see `.env.example`), or inline for a one-off.
Whichever target is in effect is printed when Vite starts, so a blank document
page is never a guessing game.

Working against a server on your own machine:

```bash
cd ../server && bun run start     # terminal 1
npm run dev:local                 # terminal 2 — proxies to localhost:8787
```

The proxy is not a convenience. The simulator's webview refuses to open a
cross-origin `EventSource`, and going through Vite makes those requests
same-origin. A packed build has no Vite, so it uses `VITE_MD_SERVER` and relies
on the server's permissive CORS instead.

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
