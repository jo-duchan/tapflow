#!/usr/bin/env bash
# PostToolUse(Edit|Write|MultiEdit): docs/*.md 산문을 편집하면 ai-tells detect 리마인더를 주입한다.
# 강제가 아니라 유도. 실제 게이트는 Stop 단계(docs-aitells-gate.sh)가 담당한다.
set -euo pipefail

input=$(cat)
fp=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""')

case "$fp" in
  */docs/*.md)
    jq -n '{
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "docs 산문을 변경했습니다. 마무리 전 /ai-tells detect로 점검하세요 (KO 번역투·em dash 삽입구 — … —·어순 주의). 이번 세션에 ai-tells를 실행하지 않으면 Stop 단계에서 마무리가 차단됩니다."
      }
    }'
    ;;
esac
exit 0
