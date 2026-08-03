// Where you have been, so getting back there is one swipe.
//
// A worked example you looked at is very likely the one you want again a
// minute later, and reaching it costs four levels of tree every time. Ten
// entries in localStorage, newest first.
//
// Not on the server. This is per-device, it is worthless to anyone else, and
// putting it there would mean an offline write queue for the one piece of state
// nobody would miss.

const KEY = "evens.enc.recent";
const MAX = 10;

export function recent(): string[] {
    try {
        const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
        return Array.isArray(raw) ? raw.filter((id) => typeof id === "string").slice(0, MAX) : [];
    } catch {
        return [];
    }
}

export function rememberVisit(id: string): void {
    try {
        // Moved to the front rather than appended, so opening the same node
        // twice does not fill the list with it.
        const next = [id, ...recent().filter((other) => other !== id)].slice(0, MAX);
        localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
        // Storage off. The list is a convenience and its absence is not worth
        // failing a page open over.
    }
}
