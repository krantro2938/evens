// Russian or Latin, for the nav rows.
//
// The panel font DOES have Cyrillic. That is measured, not assumed:
// @evenrealities/pretext ships the advance-width tables EvenHub's own font
// stack uses (evenroster -> evenroster_crylgrek -> cn -> evenemoji), and every
// Cyrillic codepoint returns a real width where the known-missing "▸" returns
// zero. "Производная" is even NARROWER than "Proizvodnaya".
//
// So why is this here? Because that is a measurement of a table shipped with an
// npm package, and the thing that actually draws the text is firmware on a pair
// of glasses. If they ever disagree the failure is silent — blank rows, no
// error, and a browser you cannot read your way out of. This is one setting
// away, it costs the pack about 2 KB (the labels are transliterated at pack
// time anyway, because MathJax has no Cyrillic and formula subscripts need it),
// and it turns an unrecoverable state into a toggle.

import type { TocNode } from "./pack";

const KEY = "evens.enc.labels";

export type LabelMode = "ru" | "lat";

let mode: LabelMode = read();

function read(): LabelMode {
    try {
        return localStorage.getItem(KEY) === "lat" ? "lat" : "ru";
    } catch {
        return "ru";
    }
}

export const labelMode = (): LabelMode => mode;

export function setLabelMode(next: LabelMode): void {
    mode = next;
    try {
        localStorage.setItem(KEY, next);
    } catch {
        // A WebView with storage disabled still gets the toggle for this
        // session, which is the session in which it was noticed to be needed.
    }
}

export const toggleLabelMode = (): LabelMode => {
    setLabelMode(mode === "ru" ? "lat" : "ru");
    return mode;
};

/** What a tree node is called, in whichever script is selected. */
export const label = (node: TocNode): string =>
    (mode === "lat" ? node.lat : node.title) || node.title;
