// Tab 4 — the encyclopedia, searched with a keyboard.
//
// The glasses browse it as a tree, which is the only thing four gestures can
// do. But a tree is the wrong shape for "where is the substitution for
// √(a²−x²)": you have to already know it lives under integrals. The phone has a
// keyboard, so this tab is the search the glasses cannot have — type a word,
// get the nodes, and send one to the glasses.
//
// It searches the SAME index the "По заданию" shortcut uses (toc.index, built
// by tools/enc/pack.ts), so a term that finds something here finds the same
// thing there. And it needs no network once the tree is cached, which is the
// point of the whole feature.
//
// Sending to the glasses is a localStorage write, not a request. Both halves of
// this app are the same WebView and the same process — main.ts drives the
// glasses, mountCompanion draws this — so the bridge is a key and a poll, the
// same way the gallery hands a photo over.

import { loadToc, type Toc } from "../enc/pack";
import { el, status } from "./dom";

/**
 * Where a "open this on the glasses" request is left.
 *
 * Read by the glasses side (see src/enc/browser.ts jumpTo). A key rather than a
 * function call because the two halves are mounted independently — the
 * companion mounts before the bridge is even connected (main.ts:100) — and a
 * direct call would be a load-order dependency between them.
 */
export const JUMP_KEY = "evens.enc.jump";

/** Matches the prefix length tools/enc/pack.ts indexed at. */
const STEM = 6;
const MAX_RESULTS = 40;

interface Hit {
    id: string;
    title: string;
    /** "Мат. анализ › Производные", so a bare "Формулы" says which topic's. */
    path: string;
    score: number;
}

/** id -> "Section › Topic", walked once when the tree lands. */
function buildPaths(toc: Toc): Map<string, string> {
    const paths = new Map<string, string>();
    const walk = (id: string, trail: string[]) => {
        const node = toc.nodes[id];
        if (!node) return;
        const here = id === "root" ? trail : [...trail, node.title];
        paths.set(id, here.join(" › "));
        for (const child of node.children ?? []) walk(child, here);
    };
    walk("root", []);
    return paths;
}

export function mountEncyclopediaTab() {
    let toc: Toc | null = null;
    let paths = new Map<string, string>();

    const state = status();
    const input = el("input", {
        type: "search",
        class: "input",
        placeholder: "интеграл, собственный вектор, ряд…",
        autocomplete: "off",
        // Not "search": on iOS that hands back a Go key that submits nothing,
        // and there is no form here to submit to.
        enterkeyhint: "done",
        "aria-label": "Поиск по справочнику",
    });
    const results = el("div", { class: "enc-list" });

    function render(hits: Hit[], query: string): void {
        results.textContent = "";
        if (!toc) return;

        if (!query.trim()) {
            state.info(
                `${Object.values(toc.nodes).filter((n) => n.pages).length} разделов. Введите слово.`,
            );
            return;
        }
        if (!hits.length) {
            state.info("Ничего не найдено");
            return;
        }
        state.clear();

        for (const hit of hits) {
            const open = el("button", { class: "enc-hit", type: "button" });
            open.append(
                el("span", { class: "enc-hit-title", text: hit.title }),
                el("span", {
                    class: "enc-hit-path",
                    text: toc!.nodes[hit.id]?.pages
                        ? `${hit.path} · ${toc!.nodes[hit.id].pages} стр.`
                        : `${hit.path} · раздел`,
                }),
            );
            open.addEventListener("click", () => {
                try {
                    // Timestamped: the glasses poll this, and opening the same
                    // node twice has to look different from not opening it.
                    localStorage.setItem(
                        JUMP_KEY,
                        JSON.stringify({ id: hit.id, at: Date.now() }),
                    );
                    state.ok(`${hit.title} — открыто на очках`);
                } catch {
                    state.error("Не удалось передать на очки");
                }
            });
            results.append(open);
        }
    }

    function search(query: string): Hit[] {
        if (!toc) return [];
        const words = query
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s-]/gu, " ")
            .split(/\s+/)
            .filter((w) => w.length >= 3);
        if (!words.length) return [];

        const scores = new Map<string, number>();
        for (const word of words) {
            const stem = word.slice(0, STEM);
            for (const id of toc.index[stem] ?? []) {
                scores.set(id, (scores.get(id) ?? 0) + 1);
            }
            // Titles are matched on the STEM, not the whole word. Russian is
            // inflected and the query almost never agrees with the heading:
            // "производная" does not appear anywhere in "Производные", so a
            // full-word match on the one topic you actually typed the name of
            // finds nothing. Six characters is the same prefix the index uses.
            for (const [id, node] of Object.entries(toc.nodes)) {
                if (node.title.toLowerCase().includes(stem)) {
                    scores.set(id, (scores.get(id) ?? 0) + 2);
                }
            }
        }

        return [...scores.entries()]
            .map(([id, score]): Hit => ({
                id,
                title: toc!.nodes[id]?.title ?? id,
                path: paths.get(id) ?? "",
                score,
            }))
            // Branches included: "Производные" is a topic, not a page, and a
            // search that only returned leaves silently dropped every topic
            // name you typed. The glasses open a branch by showing what is
            // inside it (see jumpTo), so the row does something either way.
            .filter((hit) => hit.id !== "root")
            .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
            .slice(0, MAX_RESULTS);
    }

    return {
        mount(root: HTMLElement) {
            root.append(
                el("p", {
                    class: "muted",
                    text: "Ищите здесь — открывается на очках. Работает без сети.",
                }),
                input,
                state.node,
                results,
            );

            input.addEventListener("input", () => render(search(input.value), input.value));

            state.info("Загрузка справочника…");
            void loadToc().then((loaded) => {
                if (!loaded) {
                    return state.error(
                        "Справочник не загружен. Откройте Setup → Download encyclopedia.",
                    );
                }
                toc = loaded;
                paths = buildPaths(loaded);
                render(search(input.value), input.value);
            });
        },

        refresh() {
            if (toc) render(search(input.value), input.value);
        },
    };
}
