---
description: 작업 계획 수립 — 요구사항 + 테스트 케이스 정의 (Opus 사용)
model: claude-opus-4-7
---

아래 토픽에 대한 Plan 문서를 작성한다: **$ARGUMENTS**

## 규칙

- `.work/YYYY-MM-DD-{topic}-plan.md` 파일을 **새로 생성**한다. (오늘 날짜 사용)
- `.work/CLAUDE.md`의 frontmatter 형식과 파일 명명 규칙을 반드시 따른다.
- `type: plan`, `status: draft`로 시작한다.

## 문서 구조

```
---
created: YYYY-MM-DD
status: draft
type: plan
phase: (해당 시 기입, 없으면 생략)
topic: 한 줄 요약
---

## Goal
무엇을 왜 만드는가. 1~3문장.

## Requirements
- [ ] 요구사항 1
- [ ] 요구사항 2

## Out of Scope
이번 작업에서 다루지 않는 것.

## Test Cases
| # | 시나리오 | 입력 | 기대 결과 |
|---|----------|------|-----------|
| 1 | ...      | ...  | ...       |

## Open Questions
결정이 필요한 사항. 작업 시작 전 해소해야 할 것.
```

문서 작성 후 파일 경로를 알려준다.
