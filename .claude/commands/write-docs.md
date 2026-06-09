---
description: tapflow VitePress 문서 작성 — EN/KO 동시, 사이드바 등록, 빌드 검증. 사용자 대상 가이드·레퍼런스를 새로 쓰거나 갱신할 때 사용. 내부 AGENTS.md·작업로그에는 쓰지 않는다.
model: claude-sonnet-4-6
allowed-tools: Read, Edit, Write, Bash, Glob, Grep
---

아래 주제에 대한 VitePress 문서 페이지를 작성한다: **$ARGUMENTS**

## 사전 준비

작성 전 아래 파일을 반드시 읽는다:
- `docs/AGENTS.md` — VitePress 코드블럭 규칙, CSS 주의사항
- `docs/.vitepress/config.ts` — 현재 사이드바 구조 파악

---

## 작성 규칙

### 언어

**KO가 소스 언어다.** 항상 KO를 먼저 작성하고, EN은 KO에서 번역한다.
두 버전의 내용·구조·섹션이 일치해야 한다. 한쪽에만 있는 섹션을 만들지 않는다.

#### 한국어 작성 원칙

- **완전한 문장으로 쓴다.** "수동 업로드 없이."처럼 조각 문장을 독립 문장으로 쓰지 않는다. 앞 문장에 이어 쓰거나 부사절로 처리한다.
- **자연스러운 어순:** 주어 → 부사어 → 서술어 순서를 따른다. `"CI에서 빌드를 올리면 팀원 전체가 App Center에서 바로 확인할 수 있습니다."` ✅  `"팀원 전체가 별도 설치 없이 확인할 수 있습니다. Xcode 없이."` ❌
- **독자는 이미 tapflow 사용자다.** tapflow가 무엇인지, 왜 쓰는지 다시 설명하지 않는다. 이 페이지에서 달라지는 것만 말한다.
- **"QA팀" 대신 "팀원", "팀 전체"를 쓴다.** tapflow는 QA만이 아니라 PO, PM, 디자이너, 백엔드 모두가 사용한다.

#### 영어 작성 원칙

- Em dash 뒤 단문 처리(`— no manual uploads`)는 영어에서 자연스럽다. 허용.
- 한국어에서 조각 문장으로 쓰면 안 되는 표현도 영어 em dash 패턴으로는 쓸 수 있다.
- 독자 컨텍스트는 KO와 동일 — 이미 tapflow를 아는 사용자.

### 플랫폼 중립 언어

iOS/Android 양쪽 지원 기능을 다룰 때 특정 플랫폼 도구명을 쓰지 않는다.

| ❌ | ✅ |
|----|-----|
| Xcode, Xcode 설치, no Xcode | IDE, 별도 도구 설치, no IDE |
| Android Studio | 개발 환경, IDE |
| xcodebuild | (iOS 전용 섹션에서만 허용) |

예외: 해당 섹션이 실제로 iOS 전용 또는 Android 전용인 경우 플랫폼명 명시 가능.

### tapflow 두 가지 테스트 모드

문서가 수동 테스트를 다룰 때, AI Agent 경로를 별도 기능으로 명확히 구분한다.

```md
::: info Two testing paths
This guide covers the **manual review path**: CI delivers the build; people do the testing.

For automated testing where an LLM agent controls the simulator, see [MCP in CI/CD](/guide/mcp-ci). That is a separate, experimental feature.
:::
```

KO:
```md
::: info 두 가지 테스트 경로
이 가이드는 **수동 리뷰 경로**를 다룹니다. CI가 빌드를 전달하고, 팀원이 직접 테스트하는 방식입니다.

LLM 에이전트가 시뮬레이터를 자동으로 조작하는 방식은 [CI/CD에서 MCP 활용](/ko/guide/mcp-ci)을 참고하세요. 이는 별도의 실험적 기능입니다.
:::
```

### 빌드 상태 표현

| Status | EN | KO |
|--------|----|----|
| Done | Stakeholders approved | 이해관계자 승인 완료 |
| Rejected | Issues found, needs fixes | 문제 발견, 수정 필요 |
| In Progress | Ready for review | 리뷰 준비 완료 |
| Backlog | Not yet ready | 준비 전 |

### VitePress 코드블럭 규칙 (`docs/AGENTS.md` 요약)

- `sh`/`bash` 블럭에 `<placeholder>` 쓰지 않는다 — shiki가 HTML 태그로 파싱해 색이 깨진다. 플레이스홀더는 테이블 셀 인라인 코드로만 표기한다.
- 섹션 구분에 `---` 쓰지 않는다 — h2 border-top이 이미 구분선 역할을 한다.

### GitHub Actions YAML

`${{ }}` 표현식을 `run:` 블럭 안에서 멀티라인 문자열에 직접 넣지 않는다 — YAML 들여쓰기가 깨진다.
GitHub Actions 표현식은 `env:` 섹션에서 쉘 변수로 먼저 바인딩하고, `run:` 에서는 `$VAR` 형태로 사용한다.

```yaml
# ❌ YAML 들여쓰기 깨짐
-F "body=Branch: ${{ github.ref_name }}
Commit: ${{ github.sha }}"

# ✅ env에서 바인딩 후 $'\n' 처리
env:
  BRANCH: ${{ github.ref_name }}
  COMMIT: ${{ github.sha }}
run: |
  COMMENT="Branch: $BRANCH"$'\n'"Commit: $COMMIT"
```

---

## 파일 경로 규칙

| 위치 | 경로 |
|------|------|
| EN 가이드 | `docs/guide/{slug}.md` |
| KO 가이드 | `docs/ko/guide/{slug}.md` |
| EN 레퍼런스 | `docs/reference/{slug}.md` |
| KO 레퍼런스 | `docs/ko/reference/{slug}.md` |

---

## 사이드바 등록

`docs/.vitepress/config.ts`의 `enSidebar`와 `koSidebar` **양쪽**에 항목을 추가한다.
섹션 분류는 기존 구조를 따른다 (Getting Started / Setup / Dashboard / AI Agent / Reference / Troubleshooting).

---

## 작업 순서

1. `docs/AGENTS.md`와 `docs/.vitepress/config.ts` 읽기
2. KO 파일 작성 (`docs/ko/guide/{slug}.md`)
3. EN 파일 작성 (`docs/guide/{slug}.md`) — KO 기반 번역
4. `docs/.vitepress/config.ts` 사이드바 업데이트 (EN + KO)
5. `pnpm docs:build` 실행해 빌드 오류 확인 — 오류 있으면 수정 후 재빌드
6. **AI tells detect 게이트** — `.claude/ai-tells/rules-ko.md`로 작성한 KO 산문을, `.claude/ai-tells/rules-en.md`로 EN 산문을 각각 `detect`한다. 두 파일의 **docs carve-out**(격식체 종결 균일·glossary 볼드·`~할 수 있습니다` 기능서술·em dash 단문 closing)을 적용한다. 코드·수치·테이블·frontmatter는 불가침.
   - **detect는 게이트일 뿐 자동 수정하지 않는다. `rewrite` 자동 호출 금지.** P0/P1(EN)·S1(KO)을 완료 보고에 표기하고 **사람 판단**을 받는다. (정책: `.internal/marketing/OVERVIEW.md`)

---

## 완료 보고

```
## 생성된 파일
- docs/guide/{slug}.md
- docs/ko/guide/{slug}.md

## 사이드바
- config.ts {섹션명} > "{EN 레이블}" / "{KO 레이블}" 추가

## 빌드
- ✅ pnpm docs:build 통과

## AI tells detect (게이트)
- EN: P0/P1 N건 — {인용 또는 "없음(클린)"}
- KO: S1 N건 — {인용 또는 "없음(클린)"}
- 판단 필요 항목은 사람이 확인 (자동 수정 안 함)
```
