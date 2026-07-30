# Scry — Even Hub G2 app

Vite + TypeScript + SDK + CLI + simulator. Two halves of one app:

- **on the glasses** — a dashboard of tiles, plus document pages that show
  server-rendered PNG tiles pushed over BLE;
- **on the phone** — a [companion app](#the-companion-app) in the same bundle,
  for everything that needs a keyboard, a file picker or more than two lines of
  text.

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
| Dashboard | seven tiles, four then three | swipe to move focus, tap to open |
| **AI** | the solution to the assignment on the paper, live — or a **trigger button** when there isn't one yet | swipe to page, **tap to page or to solve**, **double-tap for the action menu** |
| **Assign** | what the [lookcam reader](../../lookcam/assignment) has transcribed off the paper, live | swipe or tap to page, **double-tap for the version menu** |
| **Camera** | **what the camera sees, refreshed while you aim it** — plus every scan control | **tap to start/stop**, **swipe to rotate the view**, **double-tap for the action menu** |
| **Adri** | **a solution you wrote yourself**, edited in the camera web app | swipe or tap to page, double-tap to go back |
| **Mine** | **your own answer to the scanned assignment**, written in the companion app | swipe or tap to page, double-tap to go back |
| **Setup** | **publish the phone's newest photo as the assignment** | **tap to arm, tap again to publish**, double-tap to go back |

The two document pages are instances of `src/docPage.ts` — same tile fetching,
paging, SSE-with-poll-fallback, per-tile dedup and text fallback. They differ
only in which endpoint they read and what a tap does. The Camera page is not one
of them: it has no document, only a picture it repaints on its own schedule, but
it pushes tiles through the same `render/tilePush.ts` the document pages use.

### The Camera page

The reader's advice is the model's read on framing, and it is in the **camera's**
frame of reference — so it cannot describe a camera that is simply rotated. With
the lens rolled 90°, "Move camera UP" moves you sideways, and no prompt fixes
that, because the model cannot know how the camera sits relative to your hands.
A picture answers it in one glance, and costs a frame grab rather than a Gemini
call.

```
        ┌───────────────────────────────────────┐
        │ ┌───────────────────────────────────┐ │
        │ │                                   │ │
        │ │      what the camera sees         │ │
        │ │                     ┌─────────────┤ │
        │ │                     │ Move camera │ │
        │ └─────────────────────┤ DOWN        │ │
        │                       │ Cut off: bot│ │
        │ Live 2s ago - c3 4s ago, 2/5 read   │ │
        └───────────────────────────────────────┘
```

The advice is kept, not replaced: the picture says where the paper is, the box
says what the reader still needs (blur, glare, which edge is missing), and the
footer says whether either of them is still moving — a still picture gives no
clue on its own that it has stopped being about now.

**Start, stop, resume, rescan and clear live here**, next to the picture of what
they are about. They used to be on the Assignment page, where a tap meant to
turn a page could start a job, and where you had to act on camera advice from
the one screen that couldn't show you the camera.

**Pacing is measured, not guessed.** A camera frame does not palette-compress
the way black-background text does: a full panel of it is ~30KB against ~7KB for
a page of transcription. So each frame is scheduled off what the last one
actually cost over BLE — half of it, clamped to 0.75–3s — and the link is left
partly idle for the text containers, which must stay responsive. `Small preview`
in the menu drops to a single ~8KB tile when the link can't feed the big one.

Swipe up or down to rotate the view by 90° (the menu has the same, spelled out).
Nothing on this page pages, so the swipes were free, and rotation is what you
came here to fix.

**The preview is drawn as ink, not as a photograph.** A sheet of paper is mostly
paper, so a greyscale photo of one lights most of an emissive panel — a wall of
green, worst when the frame is blank or badly exposed and there is nothing in it
to see. The server subtracts each frame's local background instead and keeps only
what is darker than its surroundings: text, rules and the edge of the sheet,
bright on black, the way the document tiles have always been drawn. Glare and
uneven lighting are background by construction and simply stop being visible,
and a full panel drops to ~4KB. `Photo view` in the menu switches back, for the
frame that is about the room rather than the page.

A frame with nothing readable in it therefore renders **black** — which would
otherwise look exactly like a preview that had stopped arriving, so the footer
says `no detail` when the server reports the frame had no ink in it to scale.

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

Both the Assignment and Camera pages add a bordered box in the bottom-right
corner. It is always on screen (border width is part of the page definition, so
a box that came and went would force a full page rebuild and a re-push of all
four tiles). On the Camera page it carries the model's advice while a job runs —
`Move camera DOWN` over `Show the bottom of the page` — and otherwise what a tap
will do (`Tap to start reading`). The sheet is read a piece at a time (see
[the reader](../../lookcam/assignment)), so the box answers "where do I point
next", not "is the whole page in shot": the second line is the part of the sheet
still wanted, and it takes both lines when there is no direction to give. On the
Assignment page it says what you are *reading* instead: `Done - 4 problems`,
`3/5 read, need bottom`, or which archived scan is pinned. Repeating the advice
there would invite you to act on it from the one screen that can't show you the
result.

### The Setup page

One action, one sentence, and no document. It reads the phone's newest photo
into the assignment — so the fast way to scan a sheet is no longer to aim a
fixed camera at it, but to shoot it and look up:

```
        ┌───────────────────────────────────────┐
        │ SETTINGS - publish a photo            │
        │                                       │
        │ Publish IMG_20260728_1200.jpg?        │
        │ It is READ INTO the current assignment│
        │                                       │
        │ Tap again to confirm (7s)             │
        │ Double tap to go back                 │
        └───────────────────────────────────────┘
```

The photo comes from the [gallery bridge](../../lookcam/phone/gallery) on the phone — the same
setting the companion app configures, because they are one web app on one phone.

The photo is **merged into** the assignment, not published over it: a sheet too
big to photograph legibly in one shot takes several, so shoot the top, publish,
shoot the bottom, publish. (Starting a *new* assignment from a photo lives in
the companion app, where there is a screen to warn on.)

**A tap still does not publish.** The first tap *arms* and names the photo it is
about to use; the second commits. Merging costs nothing but a model call and a
slow round trip, which is exactly what a temple brushing something should not be
able to start. The arming expires after ten seconds — a confirmation that never
lapses just turns the next stray tap, minutes later, into the real one. Swipes
do nothing here for the same reason.

## The companion app

The glasses are a reader and a pair of buttons. Everything that needs a
keyboard, a file picker or more than two lines of text needs a screen, and that
screen is the phone. Same bundle, same backend, three tabs:

| Tab | What |
|---|---|
| **Photo** | give the reader a sheet: pick one from the file picker, or pull the newest from the camera roll via the gallery bridge. Each photo is **read into** the assignment, so a sheet takes as many as it takes; a checkbox turns that into "different sheet, start over", behind a confirmation |
| **Assignment** | the transcription as text you can scroll, select and **copy** — the same markdown the glasses render into tiles |
| **Solution** | **your own answer**: write it, save it, read it back. One document — saving replaces it |

(The Adri documents are edited in the **camera web app**, not here — see
`lookcam/web`. They are typed on a keyboard, and that app is the one already
open on a desktop.)

Your solution follows the same rule as the Adri documents: **there is exactly
one of it.** Saving replaces what was there rather than appending, and the
version is a hash of the text — so an edit pushes new tiles to the glasses'
Mine page on its own, while saving unchanged text costs no render and no BLE.

It is a *document*, not a row in the solve loop's `solutions` table, and that is
the point of the split: that table is what the **AI** page shows, newest row
whoever wrote it, so writing down your own working used to hide Claude's answer
on the glasses. Yours is the Mine page now and Claude's is the AI page, and you
can put them side by side without either erasing the other.

### Nothing here needs the network to be up

The phone is the device most likely to lose the server — the reader lives on a
VPS and the assignment is not usually done next to it. So every tab keeps a copy
of what it shows in `localStorage` (`src/companion/cache.ts`) and paints that
first, before the fetch even returns:

- **Assignment** — the last transcription the server confirmed, labelled
  `Offline copy — read 20m ago` when the fetch fails. Never a red error over an
  empty pane while a perfectly readable copy is on the device.
- **Solution** — the last confirmed copy, plus every keystroke of an unsaved
  draft, which wins over the server's text on reload: being one save behind
  beats losing a page of maths to a backgrounded tab.
- **A save with no signal is not refused.** It is kept as pending, the tab says
  `Not synced — saved on this phone`, and it retries by itself: when you come
  back to the tab, when the browser fires `online`, and on a slow timer while
  you sit there (a captive portal never fires `online`). A save the *server*
  refuses — too long, malformed — stops being pending and says why, because
  retrying that forever would never work.

The glasses do the same thing one layer down: document pages fall back to the
on-device tile cache and the footer reads `Offline - cached 20m ago`.

It is mounted **before** `waitForEvenAppBridge()`, which is a top-level await
that never resolves in a plain browser with no Even Hub host. Everything after
it would then be dead code — fine for the glasses, fatal for the phone screen.
So the companion knows nothing about the bridge and talks to the document server
over HTTP like any other client.


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

On the Camera page, plus `Rotate view`, `Photo view` and `Small preview` in
every state:

| State | Offers |
|---|---|
| running | Stop · Rescan from scratch |
| stopped part-way | Resume from *n* · Rescan from scratch · Clear |
| hit the capture ceiling | Raise limit & go on · Rescan from scratch · Clear |
| done | Rescan from scratch · Clear |
| nothing read yet | Start reading |

The Assignment page's menu is navigation only — `Back`, `Back to live scan` when
you are reading history, and the version picker. Nothing there can spend a
capture or throw a transcription away.

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

The corner box keeps its text throughout, so choosing "Stop" doesn't cost you
sight of the reason you're stopping. The footer mirrors the current selection as
one line — `> Rescan from scratch   2/5   tap=ok`. On the Camera page the menu
opens over the live view rather than a black backdrop: the preview simply
re-renders with the menu's rectangle reserved (`?overlay=menu`), which is the
same trick the document pages use for their variant render.

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
| `index.html` | WebView host, and the companion app's stylesheet. Viewport meta tag locks zoom; CSS kills iOS double-tap zoom + rubber-band scroll. |
| `src/main.ts` | Bridge setup, page containers, the OS event subscription, navigation. |
| `src/dashboard.ts` | Menu focus + tap routing. |
| `src/docPage.ts` | Everything a document page does: tiles, paging, SSE, fallbacks. |
| `src/menu.ts` | Reusable centred action menu — turns one gesture into a list of actions. |
| `src/ai.ts` · `src/assignment.ts` | The two document pages — configuration over `docPage`. |
| `src/camera.ts` | The Camera page: the live preview loop, and every scan control. |
| `src/settings.ts` | The Setup page: arm, confirm, publish the phone's newest photo. |
| `src/adri.ts` | The Adri page — the simplest document page: a reader, nothing to trigger. |
| `src/mine.ts` | The Mine page — the same reader over your own answer (`/mine/*`). |
| `src/gallery.ts` | The phone's camera roll and publishing a photo — shared by the Setup page and the companion app. |
| `src/companion/` | The phone-screen app: the tab shell, one module per tab, and a small DOM helper. |
| `src/render/tiles.ts` | Fetch + decode the server's tiles; tile geometry. |
| `src/render/tilePush.ts` | Getting an image into a tile container: dedup cache, `sendFailed` retry, legacy payload shape, and the BLE cost log. |
| `src/state.ts` · `src/constants.ts` | Global state; layout, container IDs, endpoints. |
| `src/debug.ts` | On-screen log panel (`appLog`). |
| `app.json` | Even Hub manifest. Declares the `network` permission; its `whitelist` must contain the exact `VITE_MD_SERVER` origin. |
| `vite.config.ts` | Dev server on 5173, LAN host binding, document-server proxy. |
