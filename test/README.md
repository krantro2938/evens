# Scry — Even Hub G2 app

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

That cross-origin build also passes the Even-side gate, which only allows
origins listed in the `network` permission's `whitelist` in `app.json`. The two
are checked independently — whitelisting an origin does not relax CORS, and
permissive CORS does not get you past the whitelist. If you point
`VITE_MD_SERVER` somewhere new, add that exact origin (scheme + host + port, no
wildcards) to `app.json` as well.

## Pages

| Page | Shows | Gestures |
|---|---|---|
| Dashboard | the four menu tiles | swipe to move focus, tap to open |
| **AI** | the solution to the assignment on the paper, live — or a **trigger button** when there isn't one yet | swipe to page, **tap to page or to solve**, **double-tap for the action menu** |
| **Assign** | what the [lookcam reader](../../lookcam/assignment) has transcribed off the paper, live | swipe to page, **tap to start/stop**, **double-tap for the action menu** |

Both document pages are instances of `src/docPage.ts` — same tile fetching,
paging, SSE-with-poll-fallback, per-tile dedup and text fallback. They differ
only in which endpoint they read and what a tap does.

### The solve button

When no solution answers the paper currently under the camera — nothing solved
yet, or the camera has moved to a new sheet — the AI page stops being a reader
and becomes a button:

```
        ┌────────────────────────────┐
        │  SOLVE WITH CLAUDE         │
        │                            │
        │  3 problems read           │
        │  assignment incomplete     │
        │                            │
        │  TAP TO RUN                │
        └────────────────────────────┘
                                Tap to solve
```

A tap asks the document server to hand the transcription to a Claude routine
(`POST /solution/solve`); the box then reports progress — `SENT TO CLAUDE`,
`CLAUDE IS SOLVING 1m 20s` — and gets out of the way when the markdown arrives
and the tiles redraw. An incomplete transcription is a warning, not a veto: the
reader is often legible well before it declares itself done, and only you can see
the paper.

It is modal on purpose, and it borrows the action menu's rectangle and dark
backdrop wholesale (`SOLVE_RECT`): a text container is transparent, so without
the backdrop this would be a button drawn over somebody else's algebra. Sharing
the rect is also what keeps `render/menuBackdrop.ts` a single generated asset
rather than one per overlay.

A *stale* solution counts as no solution — it answers a sheet that is no longer
in front of you — so the button returns on its own when you turn the page, with
nothing to clear and nothing to remember. The old solution stays readable behind
it, and the box says `(shown: earlier scan)` so the button doesn't look like it
has forgotten what it already did.

The Assignment page adds a bordered box in the bottom-right corner. It is
always on screen (border width is part of the page definition, so a box that
came and went would force a full page rebuild and a re-push of all four tiles),
and shows the most useful thing available: the model's camera advice while a
capture job runs — `▲ move_down`, "The lower third of the sheet is out of
frame" — and otherwise what a tap will do (`Tap to start reading`, `Done · 4
problems`).

### The action menu

A tap does the obvious thing, which isn't always the thing you want: a half-read
assignment can be resumed **or** scrapped and rescanned, and only you know
which. Double-tap opens a centred panel listing every action at once — swipe
slides the marker, tap confirms, double-tap or 12s of silence dismisses:

```
        ACTIONS   swipe / tap=ok
        > Resume from 7
          Rescan from scratch
          Clear
          Back
          Close
```

On the Assignment page:

| State | Offers |
|---|---|
| running | Stop · Rescan from scratch |
| stopped part-way | Resume from *n* · Rescan from scratch · Clear |
| hit the capture ceiling | Raise limit & go on · Rescan from scratch · Clear |
| done | Rescan from scratch · Clear |
| nothing read yet | Start reading |

The AI page has the same menu with its own entries — it is where you go to
re-solve a page that already has an answer, or to abandon a solve that is taking
too long:

| State | Offers |
|---|---|
| solved | Solve again |
| solving / queued | Cancel this solve |
| ready, or last solve failed | Solve now |
| nothing to solve | — |

Plus **Back to menu**, which is where double-tap used to go on its own — tap and
both swipes were already spoken for, and the SDK has no long-press, so leaving
the page became an entry in the menu that took its gesture.

The corner box keeps showing camera advice throughout, so choosing "Stop"
doesn't cost you sight of the reason you're stopping. The footer mirrors the
current selection as one line — `> Rescan from scratch   2/5   tap=ok`.

### Stacking: `zOrderIndex`

The panel overlaps the image tiles, and **that only works because every
container declares `zOrderIndex`** (SDK ≥ 0.0.12, larger draws in front):

| z | container |
|---|---|
| 0 | full-screen gesture layer |
| 1–4 | the four image tiles |
| 5 | footer / pager |
| 6 | camera-advice box |
| 7 | action menu |

Without it the host stacks by declaration order, and `rebuildPageContainer`
sends `textObject` and `imageObject` as separate lists — so **the tiles land on
top of every text container**. The menu was drawn correctly on every double-tap
and was simply never visible; so, for longer, was the camera-advice box.

Two rules the host does not forgive, and `validateEvenHubPageContainerZOrder`
checks both before the payload is sent (`main.ts` logs `Z-ORDER INVALID`):

- **all or nothing** — if one container on a page sets it, every text, list and
  image container must;
- **no duplicates** on a page: there is no tie-break.

Ordering is rendering only. Input still goes to the single container with
`isEventCapture: 1`, wherever it sits in the stack.

> The *host* has to understand `z_order_index` too, not just this SDK. On an
> older Even Hub build it is ignored and the tiles cover the panel again — which
> is why the footer keeps mirroring the selection. If the panel is invisible,
> set `MENU_IN_FOOTER = true` in `src/constants.ts` and the menu lives in the
> footer alone.

The panel is declared with the page and holds `" "` while closed — a blank text
container draws nothing. It can't be created on demand because border width is
fixed at build time, so a container that came and went would force a full page
rebuild and a re-push of all four tiles every time you opened the menu. Sliding
the selection is two text upgrades and no tile traffic.

### Backgrounds: two mechanisms, one constraint

**Text containers are transparent, and a page gets four image containers — the
document owns all four.** So an opaque background can only come from the tiles,
and there are exactly two ways to get one:

| | modal — `menu.ts` | persistent panel — `panel.ts` |
|---|---|---|
| coexists with the document | no, takes it over | yes |
| background | client **replaces** all four tiles with a generated backdrop | server **bakes** it into the document's tiles |
| frame | drawn into the backdrop PNG | drawn into the reserved rect |
| runtime cost | 4 tile pushes on open + 4 on close | none — it arrives with the tile |
| used by | the action menu | camera advice; notifications next |

Both put the chrome in an *image*, because `borderWidth` is fixed when the page
is built: a container can't grow a border on demand, and one that always had a
border would show an empty rectangle whenever it was idle. **Panels and menus
carry no border of their own — they are pure text over baked pixels.**

Adding a panel (a notification strip, say) is three steps that must agree:

1. add its rect to `reserved` for that document's tile cache (`server/index.ts`)
2. declare a matching rect + container id + z slot in `src/constants.ts`
3. `panelContainer(...)` in the page's container list, `createPanel(...)` to write

Nothing checks step 1 against step 2. If they drift, the text lands beside its
own background.

### The backdrop

**Text containers are transparent**, so a panel drawn over the document is text
over text and unreadable. There is no fifth image container to put behind it
either — the SDK caps a page at four, and the document is using all of them.

So the menu doesn't layer over the document, it *replaces* it: opening pushes
four PNGs into the tile containers that black the page out and carry the menu's
frame, and closing puts the document tiles back. The frame lives in the image
because `borderWidth` is fixed when the page is built — a bordered container
would show an empty rectangle over the document whenever the menu was closed.

```
scripts/gen-menu-backdrop.mjs  →  src/render/menuBackdrop.ts   (checked in)
```

The geometry is fixed, so the images are generated at author time (pure zlib, no
dependencies) and committed — 4 tiles, ~900 bytes total, which is far less BLE
traffic than a page turn. **Re-run the generator after changing any `MENU_*`
constant**, or the frame and the text will disagree.

While the backdrop is up, `docPage` holds document updates back (`masked`): on
the assignment page new tiles land every few seconds during a scan and would
otherwise paint straight over an open menu. The updates still reach `state`, so
closing the menu shows the newest document, not the one you opened over.

The menu itself is `src/menu.ts`, and is page-agnostic — any page that has run
out of gestures can hand one gesture to it and get as many actions as it likes:

```ts
const menu = createMenu({
    name: "Assignment",
    containerID: DOC_MENU_ID,          // declared via menuContainer(id)
    build: () => [{ label: "Stop", run: stop }, …],   // rebuilt on every open
    enqueue: (task) => page.enqueue(task),            // join the page's chain
    onPaint: () => page.updatePager(),                // repaint the mirror line
});

handleGesture(g) {
    if (menu.handleGesture(g)) return;                // menu ate it
    if (g === GESTURE_EVENTS.DOUBLE_TAP) return menu.open();
    page.handleGesture(g);
}
```

`menu.line()` returns the selection as one line (or `null` when closed) — feed
it to whatever you use as the uncoverable strip.

Each entry names a `POST /assignment/control` action; the server composes the
reader calls (see `server/assignment.ts`), so the app never has to know that a
rescan is `/reset` followed by `/start`.

> **Panel text is ASCII only.** The font has no glyph for the decorations you'd
> reach for first — `▸` logs
> `lv_draw_letter: glyph dsc. not found for U+25B8` and the label silently fails
> to appear. Arrows, check marks, bullets and `…` are spelled out (`>`, `OK`,
> `-`, `...`). Console strings via `appLog` are unaffected.

> The box overlaps the lower part of the bottom-right image tile, which assumes
> a text container draws **above** an image container. If your SDK build
> z-orders the other way, see the fallback noted at `FEEDBACK_Y` in
> `src/constants.ts` — it moves the box into the footer row instead.

## Pack for distribution

```bash
npm run build && npm run pack
```

Produces `scry.ehpk`.

`VITE_MD_SERVER` must be set (see `.env.local`) — the build fails without it.
An unset value bakes relative URLs into the bundle, and a packed app has no
proxy to resolve them, so the WebView answers every fetch with its own
`index.html`. That shows up on the glasses as:

```
Assignment task failed SyntaxError: Unexpected token '<', "<!doctype "... is not valid JSON
```

Its origin must also be in the `network` whitelist in `app.json`.

## What's in here

| File | Purpose |
|---|---|
| `index.html` | WebView host. Viewport meta tag locks zoom; CSS kills iOS double-tap zoom + rubber-band scroll. |
| `src/main.ts` | Bridge setup, page containers, the OS event subscription, navigation. |
| `src/dashboard.ts` | Menu focus + tap routing. |
| `src/docPage.ts` | Everything a document page does: tiles, paging, SSE, fallbacks. |
| `src/menu.ts` | Reusable centred action menu — turns one gesture into a list of actions. |
| `src/ai.ts` · `src/assignment.ts` | The two document pages — configuration over `docPage`. |
| `src/render/tiles.ts` | Fetch + decode the server's tiles; tile geometry. |
| `src/state.ts` · `src/constants.ts` | Global state; layout, container IDs, endpoints. |
| `src/debug.ts` | On-screen log panel (`appLog`). |
| `app.json` | Even Hub manifest. Declares the `network` permission; its `whitelist` must contain the exact `VITE_MD_SERVER` origin. |
| `vite.config.ts` | Dev server on 5173, LAN host binding, document-server proxy. |
