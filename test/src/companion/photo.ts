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
// really is a different sheet. It is a deliberate checkbox rather than the
// default, the button renames itself when it is ticked, and the confirm step
// is not skippable — this is the one control in the app that can throw away a
// scan.

import {
    bridgeUrl,
    checkBridge,
    getBridge,
    latestPhoto,
    photoBlob,
    publishPhoto,
    setBridge,
    type PhotoMeta,
} from "../gallery";
import { copyText, el, size, status } from "./dom";
import { ago } from "../utils";

export function mountPhotoTab(): { mount: (root: HTMLElement) => void; refresh: () => void } {
    const state = status();

    let chosen: { blob: Blob; name: string } | null = null;
    let preview: HTMLImageElement;
    let previewNote: HTMLElement;
    let publishButton: HTMLButtonElement;
    let latestButton: HTMLButtonElement;
    let freshBox: HTMLInputElement;
    let bridgeNote: HTMLElement;
    let refreshBridge: () => void = () => {};

    /** Whether this publish starts a new assignment instead of adding to one. */
    const startingOver = (): boolean => freshBox.checked;

    function describeChoice(): void {
        publishButton.textContent = startingOver()
            ? "Publish as a NEW assignment"
            : "Add to the assignment";
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
                    "Leave the box unticked to add this photo to what has already been read.",
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

        freshBox = el("input", { type: "checkbox", id: "photo-fresh" }) as HTMLInputElement;
        // Relabels the button as it is ticked, so what the button does is never
        // a thing you have to remember about a checkbox above it.
        freshBox.addEventListener("change", describeChoice);
        const freshLabel = el(
            "label",
            { class: "muted", for: "photo-fresh" },
            freshBox,
            el("span", {
                text: " This is a different sheet — start a new assignment (archives the current one)",
            }),
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

        const save = el("button", { class: "btn", type: "button", text: "Save" }) as HTMLButtonElement;
        save.addEventListener("click", () => {
            if (!setBridge(input.value)) {
                bridgeNote.textContent = "That is not a URL. Paste the line the script printed.";
                return;
            }
            refreshBridge();
        });

        const command = "bash ~/lookcam/phone/gallery/run.sh";
        const copy = el("button", { class: "btn", type: "button", text: "Copy command" }) as HTMLButtonElement;
        copy.addEventListener("click", () => {
            void copyText(command).then((done) => {
                bridgeNote.textContent = done ? "Copied — run it in Termux." : "Copy failed.";
            });
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

        return el(
            "details",
            { class: "card" },
            el("summary", { text: "Phone gallery bridge" }),
            el("p", {
                class: "muted",
                text: "A web page cannot read your camera roll, so a small script in Termux serves the newest photos on localhost. It lives with the other phone tooling in the lookcam repo. Run it, then paste the URL it prints.",
            }),
            el("div", { class: "row" }, el("code", { class: "code", text: command }), copy),
            el("div", { class: "row" }, input, save),
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
