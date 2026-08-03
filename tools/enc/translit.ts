// Cyrillic -> Latin.
//
// Two callers, for two unrelated reasons:
//
//   - Formulas. MathJax's fonts have no Cyrillic at all — "\text{макс}" comes
//     back as an SVG containing zero glyph paths, so a subscript like S_полн
//     renders as S with an invisible nothing under it. Short identifiers inside
//     maths are transliterated so they at least say something.
//   - Nav labels. The panel font DOES have Cyrillic (verified against
//     @evenrealities/pretext's advance-width tables, which follow EvenHub's own
//     fallback chain evenroster -> evenroster_crylgrek), so this is not needed
//     for legibility. It ships as the escape hatch behind the Setup toggle, for
//     the case where real firmware disagrees with those tables.
//
// Practical transliteration, not a standard: the goal is a Russian reader
// recognising the word, so "щ" is "sch" rather than GOST's "ss1".

const MAP: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh",
    з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
    п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts",
    ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu",
    я: "ya",
};

export function translit(text: string): string {
    let out = "";
    for (const ch of text) {
        const lower = ch.toLowerCase();
        const mapped = MAP[lower];
        if (mapped === undefined) {
            out += ch;
            continue;
        }
        // Preserve case, including the two-letter expansions: "Ш" -> "Sh".
        out += ch === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
    }
    return out;
}
