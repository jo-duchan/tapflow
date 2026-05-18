# .claude/

Claude Code 프로젝트 설정 디렉토리.

`settings.json`과 `commands/`는 팀 전체에서 공유된다.  
`settings.local.json`은 개인 권한 설정이며 `.gitignore`에 포함되어 있다.

---

## 디렉토리 구조

```
.claude/
├── commands/          # 커스텀 슬래시 커맨드 (팀 공유)
│   ├── compound.md    # /compound
│   ├── deep-research.md  # /deep-research
│   ├── doc-sync.md    # /doc-sync
│   ├── qa.md          # /qa
│   └── work-plan.md   # /work-plan
├── settings.json      # 팀 공유 설정 (hooks, statusLine 등)
├── settings.local.json  # 개인 설정 — gitignore (permissions 등)
└── README.md          # 이 파일
```

---

## 커스텀 커맨드

Claude Code에서 `/` 로 호출한다.

| 커맨드 | 설명 |
|--------|------|
| `/work-plan {topic}` | `.work/` 플랜 문서 생성. 요구사항 + 테스트 케이스 정의. |
| `/deep-research {problem}` | 구현·버그·설계 문제를 Opus로 깊이 분석. |
| `/qa {target}` | 대상 코드의 테스트를 기획하고 작성. Potemkin·Flaky 금지. |
| `/doc-sync` | CLAUDE.md·INDEX.md·`.work/` 문서와 코드베이스의 정합성 감사·수정. |
| `/compound` | 현재 작업의 재사용 패턴을 추출해 CLAUDE.md 업데이트. |

---

## settings.json vs settings.local.json

| 항목 | `settings.json` | `settings.local.json` |
|------|-----------------|----------------------|
| Git 추적 | O (팀 공유) | X (gitignore) |
| 용도 | hooks, statusLine, plugins | 개인 permissions allow |
| 예시 | 완료 알림 hook | `Bash(gh api *)` 허용 |

`settings.local.json`이 없으면 빈 파일로 생성하거나 생략해도 된다.

---

## 참고

- 커맨드 작성 규칙: [커스텀 커맨드 문서](https://docs.anthropic.com/ko/docs/claude-code/slash-commands)
- 프로젝트 컨텍스트: [`CLAUDE.md`](../CLAUDE.md), [`INDEX.md`](../INDEX.md)
- 작업 로그: [`.work/`](../.work/)
