#!/usr/bin/env bash
# Stop: 이번 세션에 docs/*.md를 편집했는데 /ai-tells detect를 한 번도 실행하지 않았으면
# 마무리를 차단(block)하고 점검을 요구한다. ai-tells를 한 번이라도 돌리면 통과 → 무한루프 없음.
set -euo pipefail

input=$(cat)
tx=$(printf '%s' "$input" | jq -r '.transcript_path // ""')
[ -f "$tx" ] || exit 0

# 안전망: Stop hook이 block으로 재진입한 상태(stop_hook_active)면 통과시켜
# 사용자가 의도적으로 건너뛸 수 있게 한다(스크립트 오류로 인한 무한 block 방지).
active=$(printf '%s' "$input" | jq -r '.stop_hook_active // false')
[ "$active" = "true" ] && exit 0

# docs/*.md를 Edit/Write/MultiEdit 한 횟수 (file_path가 input 첫 필드)
edited=$(grep -cE '"name":"(Edit|Write|MultiEdit)","input":\{"file_path":"[^"]*/docs/[^"]*\.md' "$tx" || true)
# ai-tells 스킬을 호출한 횟수 (리마인더 텍스트와 겹치지 않는 정확한 키)
ran=$(grep -cE '"skill":"ai-tells"' "$tx" || true)

if [ "${edited:-0}" -gt 0 ] && [ "${ran:-0}" -eq 0 ]; then
  jq -n '{
    decision: "block",
    reason: "이번 세션에서 docs를 편집했지만 /ai-tells detect를 실행하지 않았습니다. 마무리 전 docs 산문(KO 번역투·em dash 삽입구·어순)을 /ai-tells detect로 점검하세요. 의도적으로 건너뛰려면 그대로 다시 멈추면 통과됩니다."
  }'
fi
exit 0
