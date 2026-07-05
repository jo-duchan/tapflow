#!/bin/bash
# PreToolUse(Bash) gate: blocks `gh pr create` unless an adversarial review
# record exists for the current branch AND references the current HEAD commit.
# Review records live in .work/reviews/<branch>.md (local-only, gitignored with
# the rest of .work/). The HEAD-hash check guarantees "reviewed code == PR code":
# any commit after the review invalidates the record until it is refreshed.

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')
# Match the PR-create invocation only in command position: line start, after
# ; && |, inside $( ) capture, or after then/do. A plain substring match would
# false-positive on commit messages / docs that merely mention the command.
# Backticks are deliberately NOT a command position (markdown quoting).
# Fail-open by design (jq/git missing, not a repo): this gate guards a
# cooperative-but-forgetful agent, not an adversary.
printf '%s' "$cmd" | grep -qE '(^[[:space:]]*|(;|&&|\||\$\()[[:space:]]*|(^|[[:space:]])(then|do)[[:space:]]+)gh[[:space:]]+pr[[:space:]]+create' || exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
head=$(git rev-parse HEAD 2>/dev/null) || exit 0
record=".work/reviews/${branch//\//__}.md"

if [ ! -f "$record" ]; then
  echo "Blocked: no adversarial review record ($record). Before creating a PR, have an independent context (a fresh subagent — no extra accounts needed; Codex is optional) review the diff, then write findings and dispositions (fixed / skipped+reason) to that file, including the full 40-char HEAD hash (git rev-parse HEAD). Docs-only PR: skip the review but still write the record with the skip reason and the same full HEAD hash. If this command is not actually creating a PR (the text merely mentions the command), split that text into a separate command. See: AGENTS.md > Adversarial Review." >&2
  exit 2
fi
if ! grep -q "$head" "$record"; then
  echo "Blocked: $record does not reference the current HEAD ($head). Either commits were added after the review, or the record contains an abbreviated hash — refresh the review against the current diff and record the full 40-char hash (git rev-parse HEAD), then retry." >&2
  exit 2
fi
exit 0
