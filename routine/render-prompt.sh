#!/usr/bin/env bash
#
# Print solve.md's prompt with its placeholders filled in, ready to paste into
# the routine at <https://claude.ai/code/routines>.
#
# WHY THIS EXISTS. solve.md is a template: the prompt in it says
# `<EVENS_URL>` and `<SOLVER_TOKEN>` because those are a deployment's secrets and
# do not belong in the repository. The routine, though, stores one literal string
# — so pasting the file as it stands produces a routine that boots, finds no
# credentials, and stops. It does that politely, reporting a configuration
# problem and spending about fifty cents to do so, which is exactly why it went
# unnoticed for a day: every fire "succeeded", the button still filled the page
# in, and only the byline said Gemini instead of Claude.
#
# That happened on 2026-07-30. The routine's stored prompt was byte-identical to
# solve.md's, placeholders and all. So: don't paste the file, paste this.
#
#   SOLVER_TOKEN=... ./routine/render-prompt.sh | xclip -selection clipboard
#
# Configuration, by environment — the same names runner.sh uses:
#   SOLVER_TOKEN   required; must match the server's
#   EVENS_URL      default https://even.aansl.com
#
# The output contains the solver token in clear text, because that is what the
# routine needs. Treat it like the secret it is: pipe it to a clipboard, don't
# leave it in a file, and don't paste it into anything but the routine.

set -euo pipefail

EVENS_URL="${EVENS_URL:-https://even.aansl.com}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$HERE/solve.md"

if [[ -z "${SOLVER_TOKEN:-}" ]]; then
    echo "render-prompt: SOLVER_TOKEN is not set (it must match the server's)" >&2
    echo "render-prompt: it is in the server's .env — SOLVER_TOKEN=\$(ssh HOST 'grep ^SOLVER_TOKEN= ~/evens/.env | cut -d= -f2-')" >&2
    exit 2
fi
[[ -r "$SOURCE" ]] || { echo "render-prompt: missing $SOURCE" >&2; exit 2; }

# Everything after the `## Prompt` heading, minus the blank lines under it. The
# heading is the contract between this script and the file: keep them together.
prompt="$(awk '
    /^## Prompt$/ { found = 1; next }
    found {
        if (!started && $0 ~ /^[[:space:]]*$/) next
        started = 1
        print
    }
    END { if (!found) exit 3 }
' "$SOURCE")" || {
    echo "render-prompt: no '## Prompt' heading in $SOURCE" >&2
    exit 3
}

[[ -n "$prompt" ]] || { echo "render-prompt: the prompt section is empty" >&2; exit 3; }

prompt="${prompt//<EVENS_URL>/$EVENS_URL}"
prompt="${prompt//<SOLVER_TOKEN>/$SOLVER_TOKEN}"

# The whole point of the script, so it is worth being certain about rather than
# trusting the two substitutions above: a placeholder that survives to the
# clipboard is the bug this exists to prevent.
if grep -q '<EVENS_URL>\|<SOLVER_TOKEN>' <<<"$prompt"; then
    echo "render-prompt: a placeholder survived substitution — refusing to print it" >&2
    exit 4
fi

printf '%s\n' "$prompt"
