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
// PUBLISHING REPLACES THE ASSIGNMENT. The reader archives the current attempt
// and reads the photo as a new one (see publishPhoto in server/assignment.ts),
// because a photo is a different sheet and merging it into a half-built
// transcription would interleave two papers. The button says so, and the
// confirm step is not skippable — this is the one control in the app that can
// throw away a scan.

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
    let bridgeNote: HTMLElement;
    let refreshBridge: () => void = () => {};

    function describeChoice(): void {
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
        // Confirmed rather than armed: unlike the glasses there is a screen
        // here, so the warning can be a sentence instead of a second tap.
        const sure = confirm(
            "Publish this photo as the assignment?\n\n" +
                "The current assignment is archived and the reader starts a new one from this photo.",
        );
        if (!sure) return;

        publishButton.disabled = true;
        latestButton.disabled = true;
        state.info("Uploading, then waiting for the reader to transcribe it...");
        const result = await publishPhoto(chosen.blob, chosen.name);
        publishButton.disabled = false;
        latestButton.disabled = false;

        if (!result.ok) return state.error(`Failed: ${result.detail ?? "unknown error"}`);
        const count = result.problems ?? 0;
        state.ok(
            `Published — the reader found ${count} problem${count === 1 ? "" : "s"}` +
                `${result.done ? " and says the sheet is complete" : ""}. See the Assignment tab.`,
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
            text: "Publish as the assignment",
        }) as HTMLButtonElement;
        publishButton.disabled = true;
        publishButton.addEventListener("click", () => void doPublish());

        root.append(
            el("h2", { text: "Assignment photo" }),
            el("p", {
                class: "muted",
                text: "Publishing replaces the current assignment — the old one is archived, and the reader transcribes this photo instead.",
            }),
            el("div", { class: "row" }, pickButton, latestButton, file),
            preview,
            previewNote,
            publishButton,
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
