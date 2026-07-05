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
printf '%s' "$cmd" | grep -qE '(^[[:space:]]*|(;|&&|\||\$\(|then|do)[[:space:]]*)gh[[:space:]]+pr[[:space:]]+create' || exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
head=$(git rev-parse HEAD 2>/dev/null) || exit 0
record=".work/reviews/${branch//\//__}.md"

if [ ! -f "$record" ]; then
  echo "Blocked: adversarial review 기록이 없습니다 ($record). PR 생성 전에 독립 컨텍스트(서브에이전트 또는 Codex) 리뷰를 수행하고, 발견사항과 처리 내역(수정 또는 스킵+사유)을 해당 파일에 기록하세요. 기록에는 full 40자 HEAD 해시(git rev-parse HEAD)를 포함해야 합니다. docs-only PR이면 리뷰는 생략하되 스킵 사유를 담은 기록은 작성하세요. 이 명령이 PR 생성이 아닌데 차단됐다면(문서·메시지 본문 속 언급) 해당 텍스트를 별도 명령으로 분리하세요. 절차: AGENTS.md Adversarial Review 참고." >&2
  exit 2
fi
if ! grep -q "$head" "$record"; then
  echo "Blocked: $record 가 현재 HEAD($head)를 참조하지 않습니다. 리뷰 이후 커밋이 추가되었거나 기록에 축약 해시를 적었습니다 — 현재 diff 기준으로 리뷰를 갱신하고 full 40자 해시(git rev-parse HEAD)를 기록에 반영한 뒤 다시 시도하세요." >&2
  exit 2
fi
exit 0
