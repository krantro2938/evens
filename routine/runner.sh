#!/usr/bin/env bash
#
# Drain the solve queue with the local `claude` CLI.
#
# WHY THIS EXISTS. The intended solver is a cloud routine (see solve.md). When
# this was written it could not work at all: an Anthropic cloud session's egress
# goes through a proxy whose allowlist covers anthropic.com and the package
# registries, nothing else, so its first curl to the document server came back
#
#   connect_rejected: gateway answered 403 to CONNECT   even.aansl.com:443
#   curl: (56) CONNECT tunnel failed, response 403
#
# and it could neither claim work nor post an answer. That is fixed — the
# environment has even.aansl.com allowlisted now, and a fire on 2026-07-30
# reached /solution/claim and read the queue — so the routine is the primary
# path again and this is the fallback it was always meant to become.
#
# It stays useful, and not only as a spare: the queue and its one-time tokens are
# transport-agnostic, so this speaks exactly the API the routine does. A machine
# with `claude` already logged in can drain the queue when the routine is
# misconfigured, rate-limited, or you would rather not spend a cloud session.
#
# The one real limitation: solving only happens while this is running. A tap on
# the glasses with no runner up leaves the run queued and says so.
#
#   ./routine/runner.sh              drain once, then exit
#   ./routine/runner.sh --watch      keep draining (default every 10s)
#
# Configuration, by environment:
#   SOLVER_TOKEN   required; must match the server's
#   EVENS_URL      default https://even.aansl.com
#   SOLVER_MODEL   default sonnet   (opus for a hard paper)
#   POLL_SECONDS   default 10       (--watch only)

set -euo pipefail

EVENS_URL="${EVENS_URL:-https://even.aansl.com}"
SOLVER_MODEL="${SOLVER_MODEL:-sonnet}"
POLL_SECONDS="${POLL_SECONDS:-10}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RULES="$HERE/solve-local.md"

if [[ -z "${SOLVER_TOKEN:-}" ]]; then
    echo "runner: SOLVER_TOKEN is not set (it must match the server's)" >&2
    exit 2
fi
for cmd in curl jq claude; do
    command -v "$cmd" >/dev/null || { echo "runner: $cmd not on PATH" >&2; exit 2; }
done
[[ -r "$RULES" ]] || { echo "runner: missing $RULES" >&2; exit 2; }

log() { printf '%s runner: %s\n' "$(date +%H:%M:%S)" "$*"; }

# Tell the server the solve failed, so the glasses show a reason rather than
# waiting out the timeout. Best effort: if this can't be delivered either, the
# run times out on its own and says that instead.
report_failure() {
    local token="$1" reason="$2"
    jq -n --arg e "$reason" '{error: $e}' |
        curl -fsS -X POST "$EVENS_URL/solution/fail" \
            -H "x-run-token: $token" -H 'content-type: application/json' \
            --data-binary @- >/dev/null 2>&1 || true
}

# Returns 0 when it solved something, 1 when the queue was empty, 2 on error —
# so --watch can back off on trouble without spinning on an empty queue.
drain_one() {
    local claim run_id token markdown work
    claim=$(curl -fsS -H "x-solver-token: $SOLVER_TOKEN" "$EVENS_URL/solution/claim") || {
        log "claim request failed"
        return 2
    }

    if [[ "$(jq -r '.ok' <<<"$claim")" != "true" ]]; then
        [[ "$(jq -r '.reason // ""' <<<"$claim")" == "no_pending_run" ]] && return 1
        log "claim refused: $(jq -r '.reason // "unknown"' <<<"$claim")"
        return 2
    fi

    run_id=$(jq -r '.run_id' <<<"$claim")
    token=$(jq -r '.run_token' <<<"$claim")
    work=$(mktemp -d)
    # The token is the credential for writing to the glasses; keep the scratch
    # directory to ourselves and take it with us on the way out.
    chmod 700 "$work"
    trap 'rm -rf "$work"' RETURN

    jq -r '.assignment.markdown' <<<"$claim" > "$work/assignment.md"
    local problems complete
    problems=$(jq -r '.assignment.problems' <<<"$claim")
    complete=$(jq -r '.assignment.complete' <<<"$claim")
    log "run $run_id claimed: $problems problems, complete=$complete"

    {
        cat "$RULES"
        # Said here rather than in the rules file: it is a property of this run,
        # not of how solutions are written.
        [[ "$complete" == "true" ]] ||
            echo -e "\nThe transcription may be missing part of the page. Solve every problem that IS there, and note the gap in a final line."
        echo -e "\n---\n"
        cat "$work/assignment.md"
    } > "$work/prompt.md"

    log "solving with $SOLVER_MODEL..."
    if ! claude -p --model "$SOLVER_MODEL" < "$work/prompt.md" > "$work/solution.md"; then
        log "claude failed for run $run_id"
        report_failure "$token" "the local solver exited with an error"
        return 2
    fi
    if [[ ! -s "$work/solution.md" ]]; then
        log "claude returned nothing for run $run_id"
        report_failure "$token" "the local solver returned an empty document"
        return 2
    fi

    # jq builds the body, so LaTeX backslashes survive intact — the reason the
    # markdown never goes near a shell-quoted -d argument.
    if jq -n --rawfile md "$work/solution.md" --arg model "$SOLVER_MODEL" \
        '{markdown: $md, model: $model, notes: "local runner"}' |
        curl -fsS -X POST "$EVENS_URL/solution/submit" \
            -H "x-run-token: $token" -H 'content-type: application/json' \
            --data-binary @- | jq -e '.ok' >/dev/null; then
        log "run $run_id submitted ($(wc -c < "$work/solution.md") bytes)"
        return 0
    fi

    # Almost always the good kind of failure: someone tapped again while we were
    # solving, so this answer is stale and the server is right to refuse it.
    log "run $run_id rejected on submit (superseded?)"
    return 2
}

if [[ "${1:-}" == "--watch" ]]; then
    log "watching $EVENS_URL every ${POLL_SECONDS}s (ctrl-c to stop)"
    while true; do
        set +e
        drain_one
        case $? in
            2) sleep $((POLL_SECONDS * 3)) ;; # something's wrong: don't hammer it
            *) sleep "$POLL_SECONDS" ;;
        esac
        set -e
    done
fi

drain_one
case $? in
    0) exit 0 ;;
    1) log "nothing to solve"; exit 0 ;;
    *) exit 1 ;;
esac
