// Offline rehearsal: does the encyclopedia still work when the servers are gone?
//
// The one claim this whole feature rests on, tested rather than asserted. The
// companion half of the app mounts in a plain browser — main.ts mounts it
// BEFORE it waits for the glasses bridge — so Chromium is a real host for it:
// real IndexedDB, real fetch, the real src/enc/pack.ts. Warm the cache, refuse
// every request to /enc/*, reload the page, and see whether the tree and a node
// nobody touched this session still come back.
//
//   bun run tools/enc/offline-check.ts
//
// Needs the app on :5173 and a backend behind it — either one:
//
//   cd server && ENC_DIR=../content/enc bun run index.ts          (the VPS half)
//   python3 offline/solver.py --serve --serve-port 8384           (the phone half)
//   cd test && VITE_MD_SERVER= VITE_MD_TARGET=http://localhost:8787 npx vite
//
// Run from tools/enc so `playwright` resolves to the version pinned there —
// the same one the renderer uses.

import { chromium } from "playwright";

const APP = "http://localhost:5173";
const ok = (label: string, pass: boolean, extra = "") =>
    console.log(`${pass ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.on("pageerror", (e) => console.log("  pageerror:", e.message));
page.on("console", (m) => { if (/error|fail|enc/i.test(m.text())) console.log("  console:", m.text().slice(0, 200)); });
page.on("requestfailed", (r) => console.log("  reqfail:", r.url().slice(0, 90), r.failure()?.errorText));
page.on("response", (r) => { if (r.url().includes("/enc/")) console.log("  resp:", r.status(), r.url().slice(0, 80)); });

await page.goto(APP, { waitUntil: "networkidle" });

// ── 1. the tab exists and the tree loads ───────────────────────────────────
await page.getByRole("tab", { name: "Справочник" }).click();
await page.waitForTimeout(2500);

const status = (await page.locator(".status").last().textContent()) ?? "";
ok("tree loads from the server", /разделов/.test(status), status.trim());

// ── 2. search finds the right things ───────────────────────────────────────
const search = async (q: string) => {
    await page.locator('input[type="search"]').fill(q);
    await page.waitForTimeout(400);
    return page.locator(".enc-hit-title").allTextContents();
};

const integrals = await search("интеграл");
ok("search 'интеграл'", integrals.length > 0, `${integrals.length} hits`);

const derivative = await search("производная");
ok("search 'производная'", derivative.length > 0, `${derivative.length} hits`);

const prefix = await search("произв");
ok("prefix 'произв' matches too", prefix.length > 0, `${prefix.length} hits`);

// ── 3. tapping a result leaves a jump for the glasses ──────────────────────
await page.locator(".enc-hit").first().click();
await page.waitForTimeout(300);
const jump = await page.evaluate(() => localStorage.getItem("evens.enc.jump"));
ok("tapping a result hands it to the glasses", Boolean(jump && JSON.parse(jump).id), jump ?? "");

// ── 4. warm the cache, then take the servers away ──────────────────────────
const warmed = await page.evaluate(async () => {
    const mod = await import("/src/enc/pack.ts");
    const result = await mod.warmAll(() => {});
    return result;
});
ok("warmAll downloaded the pack", warmed.failed === 0, JSON.stringify(warmed));

// Every request from here on is refused, exactly as if both servers were down
// and the phone were in aeroplane mode.
// Only the pack's own routes. Vite serves the app's MODULES over HTTP in dev —
// in a packed build they are in the bundle — so blocking everything would be
// testing the dev server, not the cache.
await context.route(/\/enc\/(toc|node)/, (route) => route.abort());

const offline = await page.evaluate(async () => {
    const mod = await import("/src/enc/pack.ts");
    const toc = await mod.loadToc();
    const ids = Object.entries(toc?.nodes ?? {})
        .filter(([, n]: [string, any]) => n.pages)
        .map(([id]) => id);
    // A node the session never touched, so this is the IndexedDB store
    // answering rather than pack.ts's in-memory tier.
    const pick = ids[Math.floor(ids.length / 2)];
    const node = await mod.loadNode(pick);
    return {
        nodes: ids.length,
        id: pick,
        pages: node?.pages.length ?? 0,
        kinds: [...new Set((node?.pages ?? []).map((p: any) => p.kind))],
    };
});
ok("tree still readable with the network refused", offline.nodes > 100, `${offline.nodes} nodes`);
ok(
    "a node still readable with the network refused",
    offline.pages > 0,
    `${offline.id}: ${offline.pages} pages ${JSON.stringify(offline.kinds)}`,
);

// ── 5. and after a full reload, from IndexedDB alone ───────────────────────
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
const survived = await page.evaluate(async () => {
    const mod = await import("/src/enc/pack.ts");
    const toc = await mod.loadToc();
    return Object.keys(toc?.nodes ?? {}).length;
});
ok("survives a reload with no server", survived > 100, `${survived} nodes`);

await browser.close();
