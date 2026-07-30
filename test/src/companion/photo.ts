// Tab 1 — give the reader a sheet to read.
//
// Two ways in, because they answer different questions:
//
//   Pick a photo    the file picker. Any photo, including one from last week
//                   or one someone sent you. Costs two taps on the phone.
//   Use the latest  whatever the camera roll's newest image is, via the
//                   gallery bridge. Costs one tap, and is the same action the
//                   glasses' Settings page performs — so the workflow is:
//                   shoot the sheet, then publish it from either device.
//
// PUBLISHING ADDS TO THE ASSIGNMENT. A sheet no camera can fit in one readable
// frame is read as SEVERAL photos of it — top, then bottom, then the corner
// that was in shadow — and each is merged into the same transcription (see
// publishPhoto in server/assignment.ts), the way the fixed camera's frames are.
// So the ordinary loop on this tab is: shoot a part, publish, shoot the next,
// publish, and watch the Assignment tab fill in.
//
// "Start a new assignment" is the other thing, and it is the destructive one:
// it archives what has been read and begins again from this photo, for when it
// really is a different sheet. It is TICKED BY DEFAULT, because the common case
// is arriving here with a sheet the reader has not seen — so the guards around
// it carry the weight: the checkbox is a full-width control sitting under the
// button, it turns red when armed, the button renames itself to say what it
// will do, and the confirm step is not skippable. Untick it to add a second
// photo of the sheet already being read. This is the one control in the app
// that can throw away a scan.

import {
    bridgeUrl,
    checkBridge,
    getBridge,
    latestPhoto,
    loadBridge,
    photoBlob,
    publishPhoto,
    setBridge,
    type PhotoMeta,
} from "../gallery";
import { copyText, el, size, status } from "./dom";
import { ago } from "../utils";

/**
 * How long after the last keystroke the bridge URL is committed.
 *
 * Short enough that no realistic gap between typing and tapping "Use latest"
 * loses it, long enough that pasting a URL and correcting a character does not
 * fire a health check per keystroke. `change` commits immediately regardless.
 */
const BRIDGE_SAVE_DEBOUNCE_MS = 400;

export function mountPhotoTab(): { mount: (root: HTMLElement) => void; refresh: () => void } {
    const state = status();

    let chosen: { blob: Blob; name: string } | null = null;
    let preview: HTMLImageElement;
    let previewNote: HTMLElement;
    let publishButton: HTMLButtonElement;
    let latestButton: HTMLButtonElement;
    let freshBox: HTMLInputElement;
    let freshLabel: HTMLElement;
    let bridgeNote: HTMLElement;
    let refreshBridge: () => void = () => {};

    /** Whether this publish starts a new assignment instead of adding to one. */
    const startingOver = (): boolean => freshBox.checked;

    function describeChoice(): void {
        publishButton.textContent = startingOver()
            ? "Publish as a NEW assignment"
            : "Add to the assignment";
        freshLabel.className = startingOver() ? "check on" : "check";
        if (!chosen) {
            preview.hidden = true;
            previewNote.textContent = "Nothing chosen yet.";
            publishButton.disabled = true;
            return;
        }
        preview.src = URL.createObjectURL(chosen.blob);
        preview.hidden = false;
        previewNote.textContent = `${chosen.name} — ${size(chosen.blob.size)}`;
        publishButton.disabled = false;
    }

    async function doPublish(): Promise<void> {
        if (!chosen) return;
        const reset = startingOver();
        // Only the destructive path asks. Adding a photo to a scan is the
        // ordinary action here and is done several times in a row — putting a
        // dialog in front of it would train the reflex that dismisses the one
        // warning worth reading. Unlike the glasses there is a screen here, so
        // that warning can be a sentence instead of a second tap.
        if (reset) {
            const sure = confirm(
                "Start a NEW assignment from this photo?\n\n" +
                    "The current assignment is archived and the reader begins again from this photo. " +
                    "Untick “This is a different sheet” to add this photo to what has already been read instead.",
            );
            if (!sure) return;
        }

        publishButton.disabled = true;
        latestButton.disabled = true;
        state.info("Uploading, then waiting for the reader to transcribe it...");
        const result = await publishPhoto(chosen.blob, chosen.name, { reset });
        publishButton.disabled = false;
        latestButton.disabled = false;

        if (!result.ok) return state.error(`Failed: ${result.detail ?? "unknown error"}`);
        const count = result.problems ?? 0;
        state.ok(
            `${reset ? "Published" : "Added"} — the reader now has ${count} problem${count === 1 ? "" : "s"}` +
                `${
                    result.done
                        ? " and says the sheet is complete"
                        : ". Photograph the part it hasn't read yet and add that too"
                }. See the Assignment tab.`,
        );
    }

    async function useLatest(): Promise<void> {
        state.info("Asking the phone for its newest photo...");
        try {
            // By id, not "the latest" a second time: the two calls straddle a
            // moment in which another photo can be taken, and the name shown
            // must be the bytes published.
            const meta = await latestPhoto();
            const blob = await photoBlob(meta.id);
            chosen = { blob, name: meta.name };
            describeChoice();
            state.ok(`Loaded ${meta.name}, taken ${ago(meta.taken_at)}. Publish it below.`);
        } catch (err) {
            state.error(err instanceof Error ? err.message : String(err));
        }
    }

    function mount(root: HTMLElement): void {
        // ── the two sources ─────────────────────────────────────────────────
        const file = el("input", {
            type: "file",
            accept: "image/jpeg,image/png,image/webp,image/heic,image/heif",
            class: "offscreen",
            id: "photo-file",
        }) as HTMLInputElement;
        file.addEventListener("change", () => {
            const picked = file.files?.[0];
            if (!picked) return;
            chosen = { blob: picked, name: picked.name };
            describeChoice();
            state.clear();
        });

        const pickButton = el("button", {
            class: "btn",
            type: "button",
            text: "Pick a photo",
        }) as HTMLButtonElement;
        pickButton.addEventListener("click", () => file.click());

        latestButton = el("button", {
            class: "btn",
            type: "button",
            text: "Use latest from gallery",
        }) as HTMLButtonElement;
        latestButton.addEventListener("click", () => void useLatest());

        preview = el("img", { class: "preview", alt: "the photo to publish" }) as HTMLImageElement;
        preview.hidden = true;
        previewNote = el("p", { class: "muted" });

        publishButton = el("button", {
            class: "btn primary",
            type: "button",
            text: "Add to the assignment",
        }) as HTMLButtonElement;
        publishButton.disabled = true;
        publishButton.addEventListener("click", () => void doPublish());

        freshBox = el("input", {
            type: "checkbox",
            id: "photo-fresh",
            // Ticked on arrival: most photographs taken here are of a sheet the
            // reader has not seen. Untick it to add another photo of the sheet
            // it is already reading.
            checked: true,
        }) as HTMLInputElement;
        // Relabels the button as it is ticked, so what the button does is never
        // a thing you have to remember about a checkbox below it.
        freshBox.addEventListener("change", describeChoice);
        freshLabel = el(
            "label",
            { class: "check", for: "photo-fresh" },
            freshBox,
            el(
                "span",
                {},
                el("span", { class: "title", text: "This is a different sheet" }),
                el("span", {
                    class: "why",
                    text: "Starts a new assignment from this photo and archives the current one. Untick to add this photo to what has already been read.",
                }),
            ),
        );

        root.append(
            el("h2", { text: "Assignment photo" }),
            el("p", {
                class: "muted",
                text: "Each photo is read into the assignment the reader is building, the way the camera's frames are. A sheet too big to photograph legibly in one shot takes several: publish the top, then the bottom, then anything still missing.",
            }),
            el("div", { class: "row" }, pickButton, latestButton, file),
            preview,
            previewNote,
            publishButton,
            freshLabel,
            state.node,
            bridgeSection(),
        );

        describeChoice();
    }

    // ── the gallery bridge, configured once ─────────────────────────────────
    //
    // Lives on this tab rather than in a settings tab of its own because this
    // is the only feature that uses it, and a setting explained next to the
    // button it powers is a setting you can actually act on.
    //
    // CONFIGURED ONCE IS THE POINT, AND IT USED NOT TO BE. Two things were in
    // the way, and only the second one was the real problem:
    //
    //   the Save button   the URL was committed by a tap on Save, in a section
    //                     collapsed inside a <details> next to a button that
    //                     works the moment a URL is in the field. Paste, tap
    //                     "Use latest", walk away, and nothing was stored. It
    //                     now saves as you type, and on blur.
    //   localStorage      which the WebView does not keep across launches, so
    //                     even a saved URL was gone on reopen. The setting now
    //                     lives on the document server (see loadBridge in
    //                     ../gallery.ts); storage is only a cache of it.
    //
    // The token survives Termux restarts too (the script keeps it in
    // ~/.evens-gallery-token), so one paste really is meant to be the last one.
    // Editing the field replaces it and emptying it forgets it, which is the
    // whole of "still able to change it".
    function bridgeSection(): HTMLElement {
        const input = el("input", {
            type: "url",
            class: "input",
            placeholder: "http://127.0.0.1:8790?t=…",
            value: bridgeUrl(),
            inputmode: "url",
            autocapitalize: "off",
            autocorrect: "off",
            spellcheck: "false",
        }) as HTMLInputElement;

        bridgeNote = el("p", { class: "muted" });

        /** Commit what is in the field, and say what that did. */
        function store(): void {
            const raw = input.value.trim();
            if (!setBridge(raw)) {
                // Mid-paste on a phone keyboard is not a mistake worth a red
                // line, so this says what is missing without claiming failure —
                // and leaves whatever was stored before alone until this parses.
                bridgeNote.textContent =
                    "Not a URL yet — paste the whole line, including http:// and ?t=…";
                return;
            }
            refreshBridge();
        }

        // Typing is the save. Debounced only so that a paste followed by more
        // typing does not fire a health check per keystroke.
        let pending: ReturnType<typeof setTimeout> | undefined;
        input.addEventListener("input", () => {
            clearTimeout(pending);
            pending = setTimeout(store, BRIDGE_SAVE_DEBOUNCE_MS);
        });
        // Leaving the field, or the keyboard's Go key, commits immediately —
        // the debounce must never be the reason a setting was lost.
        input.addEventListener("change", () => {
            clearTimeout(pending);
            store();
        });

        const command = "bash ~/lookcam/phone/gallery/run.sh";
        const copy = el("button", { class: "btn", type: "button", text: "Copy command" }) as HTMLButtonElement;
        copy.addEventListener("click", () => {
            void copyText(command).then((done) => {
                bridgeNote.textContent = done ? "Copied — run it in Termux." : "Copy failed.";
            });
        });

        // What used to be Save. The URL needs no button now, but "is it up?"
        // does: Termux is usually started AFTER the app is already open, and
        // until this the only way to re-test was to leave the tab and come back.
        const check = el("button", {
            class: "btn",
            type: "button",
            text: "Check",
        }) as HTMLButtonElement;
        check.addEventListener("click", () => {
            clearTimeout(pending);
            store();
        });

        refreshBridge = () => {
            latestButton.disabled = !getBridge();
            if (!getBridge()) {
                bridgeNote.textContent = "Not configured — “Use latest from gallery” is off.";
                return;
            }
            bridgeNote.textContent = "Checking...";
            void checkBridge().then((health) => {
                bridgeNote.textContent = health.ok
                    ? `Connected. Watching ${health.roots.length} folder${health.roots.length === 1 ? "" : "s"}.`
                    : `Not reachable: ${health.detail ?? "no answer"}`;
            });
        };

        // The server's copy, which is the one that survives a launch. Lands
        // after the first paint, so the field is drawn from the local cache and
        // then corrected — but never under your fingers: a value arriving while
        // you are mid-paste would replace what you are typing.
        void loadBridge().then((changed) => {
            if (changed && document.activeElement !== input) input.value = bridgeUrl();
            refreshBridge();
        });

        return el(
            "details",
            { class: "card" },
            el("summary", { text: "Phone gallery bridge" }),
            el("p", {
                class: "muted",
                text: "A web page cannot read your camera roll, so a small script in Termux serves the newest photos on localhost. It lives with the other phone tooling in the lookcam repo. Run it, then paste the URL it prints — once. It saves as you type and is kept on the document server rather than on this phone, so reopening the app finds it already here and the glasses' Setup page gets it too; edit it to change it, clear it to forget it.",
            }),
            el("div", { class: "row" }, el("code", { class: "code", text: command }), copy),
            el("div", { class: "row" }, input, check),
            bridgeNote,
        );
    }

    return {
        mount,
        refresh: () => {
            refreshBridge();
            // Deliberately does NOT re-fetch the latest photo. Coming back to
            // this tab after taking one should show you the photo you chose,
            // not silently swap it for a newer one you have not looked at.
        },
    };
}

/** Re-exported for the tests-by-hand in the README. */
export type { PhotoMeta };
