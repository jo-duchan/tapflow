#!/usr/bin/env bash
# Stop: if an a11y-lens pre-commit check was skipped and its files are still unreviewed, block
# finishing once and ask for `a11y-lens check --pending`.
#
# **Why a gate at all.** The pre-commit job never blocks on its own infrastructure â a timeout, an
# agent error, unparseable output, a file dropped for the prompt budget â so it exits 0 and lefthook
# prints the same âï¸ as a clean run (#827). a11y-lens records those files under the git common dir,
# and this is where somebody finally hears about it: an agent session usually ends right after its
# last commit, before any later commit could print the CLI's own warning.
#
# **Satisfied inside the session, not only by the files.** Stop fires at the end of every turn, and
# `--pending` is the same agent call that just failed; if it fails again the files stay, and a gate
# that looked only at them would block every turn after. So a `--pending` run in this session's
# transcript passes, the way one `/ai-tells` run passes `docs-aitells-gate.sh` â **but only for what
# was recorded before it.** A skip later in the same session writes a newer file and blocks again;
# a failed `--pending` rewrites nothing, so it does not.
#
# **Only what was recorded since this session started.** The directory is shared by every session and worktree of the
# checkout, so counting all of it blocked sessions that committed nothing: 97 records left by one
# merged PR's worktree stopped a research-only session a day later, and following them up meant
# re-sending ~540k characters of diffs nobody could act on. A record older than the transcript's first
# timestamp belongs to a session that had already ended; the CLI still warns about it on the next
# check. A newer one is not necessarily this session's: a concurrent session in another worktree, or
# this one resumed across days, still blocks here. Telling those apart needs the record's `worktree`
# matched against the session, which would miss subagents in isolated worktrees, so it is not done.
# With no session start to read — none in the transcript, or one `touch` cannot parse — every record
# counts.
#
# **Reads the layout, not the records.** a11y-lens documents `<git-common-dir>/a11y-lens/pending/
# *.json` as a public contract; counting files there needs no schema. The test builds its fixture
# with the installed CLI rather than by hand, so a layout change in an upgrade fails it instead of
# turning this gate silently off.
#
# English, because `.claude/` is committed and a contributor's agent reads it.
set -euo pipefail

input=$(cat)

# Fail open on anything unparseable, like every other gate in this directory.
active=$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null) || exit 0
[ "$active" = "true" ] && exit 0

common=$(cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null && git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
count=$(find "$common/a11y-lens/pending" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ') || exit 0
[ "${count:-0}" -gt 0 ] || exit 0

pending="$common/a11y-lens/pending"

# How many records were written after an ISO timestamp. Fails when the timestamp cannot be read.
newer_than() {
  local ref n
  ref=$(mktemp) || return 1
  if ! touch -d "$1" "$ref" 2>/dev/null; then
    rm -f "$ref"
    return 1
  fi
  n=$(find "$pending" -maxdepth 1 -name '*.json' -newer "$ref" 2>/dev/null | wc -l | tr -d ' ')
  rm -f "$ref"
  printf '%s' "${n:-0}"
}

tx=$(printf '%s' "$input" | jq -r '.transcript_path // ""' 2>/dev/null) || tx=""
if [ -n "$tx" ] && [ -f "$tx" ]; then
  start=$(jq -nrR 'first(inputs | fromjson? | .timestamp? // empty | strings) // empty' "$tx" 2>/dev/null) || start=""
  if [ -n "$start" ]; then
    n=$(newer_than "$start") || n=1
    [ "$n" -eq 0 ] && exit 0
  fi

  # The last `--pending` call, by the record's timestamp. Matched where a command starts â the
  # beginning, or after `;` `&` `|` `(` or a newline â with optional `VAR=value` prefixes, a runner
  # (`pnpm exec`, `npx`, `yarn`, `bunx`, `node`) and a path. A grep or echo that merely names the
  # command would otherwise pass the gate with the files still unreviewed. It is not a shell parser:
  # `bash -c "â¦"` is missed, which costs one extra stop. Line continuations are joined first.
  last=$(jq -rR 'fromjson? | .timestamp as $t | .message.content[]? | select(.type=="tool_use" and .name=="Bash") | .input.command // empty | gsub("\\\\\n"; " ") | select(test("(^|[;&|(\n])\\s*([A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*((pnpm|npx|yarn|bunx)\\s+(exec\\s+)?|node\\s+)?(\\S*/)?a11y-lens(\\.mjs)?\\s+check\\b[^;&|\n]*--pending")) | $t // empty' "$tx" 2>/dev/null | tail -n 1) || last=""
  if [ -n "$last" ]; then
    n=$(newer_than "$last") || exit 0
    [ "$n" -eq 0 ] && exit 0
  fi
fi

jq -n '{
  decision: "block",
  reason: "An a11y-lens pre-commit check in this session was skipped (timeout, agent error, or prompt budget), so some committed UI files were never reviewed. Run `pnpm exec a11y-lens check --pending` with the Bash tool timeout at 600000 or in the background: each skipped commit is its own agent call of up to 3 minutes. Address any errors it reports. If it reports records it cannot read, delete those files from `.git/a11y-lens/pending/` by hand. To skip deliberately, just stop again and this passes."
}'
exit 0
