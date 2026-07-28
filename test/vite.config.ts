import { defineConfig, loadEnv } from "vite";

// The app talks to exactly one origin: the document server. /markdown, /tiles,
// /events and /assignment/* all live there, and the lookcam assignment reader
// sits behind it — so one variable configures the whole app.
//
//   dev           VITE_MD_TARGET  where Vite proxies the routes below
//   packed build  VITE_MD_SERVER  absolute URL compiled into the bundle
//
// The proxy is not a convenience: the simulator's webview refuses to open a
// cross-origin EventSource, and proxying makes those requests same-origin.
//
// Set either in .env.local (see .env.example); process.env still wins, so
// `VITE_MD_TARGET=... npm run dev` works for a one-off.

const DEFAULT_TARGET = "https://even.aansl.com";

/** Every route the document server owns. Both document pages are instances of
 *  the same component, so this list is the complete surface. `/solution` is the
 *  AI page's solve state and its trigger button. */
const DOC_ROUTES = [
    "/markdown",
    "/tiles",
    "/events",
    "/assignment",
    "/solution",
    // The hand-written documents: "/doc" is where the companion app edits them,
    // "/adri" is where the glasses read one back.
    "/doc",
    "/adri",
    // The app ships its own log here — the glasses have no console.
    "/log",
];

export default defineConfig(({ mode, command }) => {
    // "" prefix: these are build-time config, not VITE_-exposed client vars.
    const env = loadEnv(mode, process.cwd(), "");
    const target = env.VITE_MD_TARGET || DEFAULT_TARGET;

    // A build with no VITE_MD_SERVER produces a bundle whose fetches are all
    // relative. There is no proxy in a packed app, so they resolve against the
    // bundle itself and the WebView hands back index.html — which surfaces on
    // the glasses as `Unexpected token '<', "<!doctype "... is not valid JSON`,
    // long after the build that caused it. Fail here instead.
    if (command === "build" && !env.VITE_MD_SERVER) {
        throw new Error(
            "VITE_MD_SERVER is not set — a packed build needs the document " +
                `server's absolute URL (e.g. ${DEFAULT_TARGET}). Set it in ` +
                ".env.local, and make sure the same origin is in app.json's " +
                "network whitelist.",
        );
    }

    // Printed because "which server am I actually pointed at" is the first
    // question whenever a document page comes up blank.
    console.log(`\n  document server → ${target}\n`);

    return {
        server: {
            host: true,
            port: 5173,
            proxy: Object.fromEntries(
                DOC_ROUTES.map((route) => [
                    route,
                    { target, changeOrigin: true },
                ]),
            ),
        },
        build: { target: "esnext" },
    };
});
