---
description: tapflow VitePress 문서 작성·갱신 — 페이지 유형별 독자, 소스 대조 검증, EN/KO 동시, 사이드바·llms.txt 등록, 빌드 검증. 사용자 대상 가이드·레퍼런스를 새로 쓰거나 고칠 때 사용. 내부 AGENTS.md·작업로그에는 쓰지 않는다.
model: claude-sonnet-5
allowed-tools: Read, Edit, Write, Bash, Glob, Grep
---

아래 주제로 VitePress 문서를 작성하거나 갱신한다: **$ARGUMENTS**

## 사전 준비

- `docs/AGENTS.md` — 한/영 동시 작성, 플랫폼 중립 언어, 코드블럭·`---` 금지 규칙의 **정본**. 이 커맨드는 그 규칙을 다시 적지 않는다. 읽고 따른다.
- `docs/.vitepress/config.ts` — 현재 사이드바 구조
- 갱신이면 대상 페이지 EN/KO 양쪽

## 모드

- **새 페이지**: 아래 유형 중 하나를 고르고 템플릿에서 시작한다. 등록 3곳(EN 사이드바, KO 사이드바, `llms.txt`)을 빠뜨리지 않는다.
- **기존 페이지 갱신**: 페이지 구조와 헤딩 id를 유지한 채 고친다. 기존 페이지에 frontmatter가 없으면 이번에 `description`을 추가한다.
- **사실이 바뀌는 모든 변경**(명령·플래그·기본값·숫자·UI 레이블 등): 같은 사실이 나오는 곳을 `docs/` 전체(EN + KO, `docs/public/llms.txt` 포함)에서 grep해 같은 변경에서 모두 고친다. 감사에서 `android-34`(실제는 `setup.ts`의 `android-35`)가 세 페이지에 퍼져 있었던 것처럼, 한 곳만 고치면 나머지가 틀린 채 남는다.

## 1. 독자 — 페이지 유형이 정한다

"독자는 이미 tapflow 사용자다"라는 가정은 쓰지 않는다. 그 가정이 온보딩 경로에서 정의 없는 용어와 역할 구분 없는 안내를 만들었다(팀원을 대상으로 한 페이지가 27개 중 2개).

| 유형 | 독자 | 해당 페이지 예 |
|---|---|---|
| 튜토리얼 / 소개 / 팀원 대상 | tapflow를 처음 보는 사람 | Introduction, Quick Start, 팀원 가이드 |
| How-to | tapflow를 세팅하는 운영자 | Environment Setup, Self-Hosting, Agent Setup, Build Distribution |
| 기능 페이지 | 브라우저로 쓰는 팀원 (+ 운영자 설정 절) | Audio, Network Control, Streaming |
| 레퍼런스 | 무언가를 찾아보는 사용자 | CLI, Configuration, REST API |
| 개념 | 동작 원리를 알고 싶은 사람 | Performance, Security |

모든 유형에 공통으로 적용한다.

- **첫 문단은 이 페이지로 무엇을 할 수 있게 되는지 말한다.** 기능 페이지라면 무엇을 하는지, 지원 플랫폼, 기본 켜짐 여부까지 쓴다.
- **검색으로 바로 들어와도 읽혀야 한다.** 사이드바 순서로 왔다고 가정하지 않고, 전제조건은 링크로 건다.
- **처음 보는 독자 대상 페이지에서는 용어를 처음 나올 때 한 줄로 정의한다.** relay(대시보드와 에이전트를 잇는 서버), agent(시뮬레이터·에뮬레이터를 띄우는 Mac 쪽 프로세스), App Center(tapflow 대시보드 안의 빌드 목록 화면으로, Microsoft App Center와 무관) 등이 대상이다. "agent"는 tapflow agent만 뜻하고, Claude Code 같은 도구는 "coding agent"로 쓴다.
- 누가 하는 일인지 구분한다. Mac 세팅은 운영자가 하고, 팀원은 브라우저만 연다.

## 2. 소스 대조 검증 (작성 전 + 작성 후)

명령, 플래그, 설정 키, 환경 변수, 기본값, 숫자, API 경로, 샘플 출력, 대시보드 UI 레이블은 **모두 소스에서 찾은 것만 쓴다.** 기억이나 다른 docs 페이지를 근거로 쓰지 않는다. 다른 페이지는 틀려 있을 수 있다.

| 사실 | 찾을 곳 |
|---|---|
| CLI 명령·플래그 | `packages/cli/src/index.ts`(commander 정의), `packages/cli/src/commands/*.ts` |
| setup·doctor 동작, 출력 문구 | `packages/cli/src/lib/setup.ts`, `packages/cli/src/lib/doctor.ts`, `packages/cli/src/commands/*.ts` |
| 설정 키·기본값·환경 변수 | `packages/relay/src/lib/config.ts`, `grep -rn "process.env" packages/*/src` |
| REST API 경로·인증·스코프 | `packages/relay/src/router.ts`, `packages/relay/src/api/*.ts`, `packages/relay/src/middleware/` |
| 대시보드 UI 레이블·흐름 | `packages/dashboard/src/pages/`, `packages/dashboard/components/` |

- **작성 전**: 페이지에 들어갈 사실 목록을 만들고 각각의 `file:line`을 찾는다. 소스에서 못 찾으면 쓰지 않고 완료 보고에 "미확인"으로 적는다.
- **작성 후**: 쓴 문서를 다시 읽으며 사실마다 목록과 대조한다. 샘플 출력은 실제 출력 코드와 글자 단위로 맞춘다.

## 3. 페이지 템플릿

새 페이지는 frontmatter `title`·`description`이 필수다. 아래 템플릿은 본문만 보여 주므로, 어느 유형이든 이 머리말을 맨 위에 붙인다.

```md
---
title: {제목}
description: {한 문장. llms.txt 설명과 맞춘다}
---
```

템플릿의 섹션 순서는 유지하되, 해당 없는 섹션은 생략한다.

**튜토리얼** (처음부터 끝까지 따라 하면 결과가 보이는 페이지)
```md
# {무엇을 해내는가}
{끝나면 무엇이 되어 있는지 1~2문장}
::: info 시작하기 전에   ← 하드웨어, OS, 필요한 권한, 걸리는 시간(조건부로)
## 1. {단계}   ← 단계마다 실행할 것과 기대 결과(실제 출력)
## 다음 단계
```

**How-to** (목표가 있는 운영자, 동작만 쓰고 배경 설명은 링크로 뺀다)
```md
# {결과를 말하는 제목}
{이 페이지로 무엇을 설정하게 되는지. 전제조건 링크}
## {단계 또는 시나리오}   ← 옵션 전체 목록은 레퍼런스로 링크
## 문제 해결 / 관련 문서
```

**기능 페이지** (팀원 관점)
```md
---
title: {기능 이름}
description: {한 문장. llms.txt 설명과 맞춘다}
---
# {기능 이름}
<Badge type="info" text="iOS" /> <Badge type="info" text="Android" />
{무엇을 하고 누구에게 쓸모 있는지 1~2문장, 기본 켜짐 여부}
<VideoPlayer ... />   ← 있으면
## How to use          ← 대시보드에서의 단계
## Platform support    ← iOS/Android 표: 지원 여부, 전제조건, 차이
## Limits
## Setup (operator)    ← 운영자 작업이 필요한 기능만. 팀원이 건너뛸 수 있게 분리
## Troubleshooting     ← 이 기능에 한정된 증상. 공통 증상은 /troubleshooting 아래 영역 페이지 링크
## Related
```
KO 헤딩은 `사용 방법 / 플랫폼 지원 / 제한 사항 / 설정(운영자) / 문제 해결 / 관련 문서`처럼 옮기고 `{#id}`는 EN과 같게 둔다.

**레퍼런스** (찾아보는 사용자, 명령형, 표 중심)
```md
# {대상}
{이 페이지가 다루는 범위 1문장}
## {항목}   ← 표: 이름 / 설명 / 기본값. 사용 흐름은 가이드로 링크
```

**개념** (동작 원리와 트레이드오프)
```md
# {주제}
{무슨 질문에 답하는 페이지인지}
## {개념}   ← 그림이나 표. 절차는 how-to로 링크
## 관련 문서
```

공통 요소:
- 건너뛰어도 되는 심화 내용은 `::: tip` / `::: details`로 묶어 처음 보는 독자가 흐름을 놓치지 않게 한다("Good to know" 역할).
- 모든 페이지는 `## 다음 단계`(튜토리얼) 또는 `## 관련 문서`(나머지)로 끝난다. 링크마다 무엇이 있는지 한 줄을 붙인다.

## 4. 헤딩 id와 앵커

- 다른 페이지가 링크할 만한 새 헤딩에는 EN/KO 양쪽에 같은 `{#english-id}`를 붙인다. KO 자동 슬러그는 한글(`#외부-접속`)이라 헤딩 문구만 고쳐도 링크가 끊긴다. VitePress 빌드는 `#앵커`를 검사하지 않으므로 `docsAnchors` 테스트가 대신 잡는다.
- 기존 헤딩 문구를 바꿀 때는 원래 슬러그를 `{#기존-id}`로 명시해 id를 유지한다.
- 배포된 코드에 박힌 앵커는 절대 옮기거나 바꾸지 않는다. `docsAnchors`의 `LEGACY_URLS`가 원래 형태 그대로 검사한다.
  - `/reference/configuration#https-secure-context`: `packages/dashboard/components/perf/PerformanceModeNotice.tsx:13`. EN/KO 헤딩 양쪽에 명시적 id `{#https-secure-context}`가 있다. KO의 옛 슬러그는 헤딩 아래 `<a id="https-보안-컨텍스트"></a>`로 남아 있다.
  - `/guide/troubleshooting#ios-simulator-service-version-mismatch`: `packages/ios-agent/src/simctl.ts:49`. 페이지가 나뉘어 옛 URL은 `/troubleshooting`으로 308 리다이렉트되고, 그 페이지의 Moved sections 항목(`<a id>`)이 섹션이 옮겨 간 `/troubleshooting/ios-simulator#…`(명시적 id)로 안내한다.
  - `/guide/self-hosting#docker-compose-lan-server`: 예전 README(npm에 배포됨). 같은 방식으로 `/operate/deployment`의 Moved sections를 거쳐 `/operate/docker`로 간다.
- **한 번 렌더된 id는 없어지지 않는다.** `docs/.vitepress/frozen-ids.json`은 개편 직전(main `74bc7dc8`)에 렌더된 모든 id(EN + KO)이고, `docsMoves` 테스트가 페이지 이동을 따라가 지금도 그 id가 있는지 검사한다. 헤딩 문구를 바꾸면 `{#기존-id}`를 붙이거나, `<a id="기존-id"></a>`를 남기거나, 섹션이 다른 페이지로 갔다면 Moved sections 항목(`<a id="…" data-moved-to="/새/경로#id">`)을 둔다. 이 파일은 다시 생성하지 않는다.

## 5. 등록

새 페이지는 세 곳에 등록한다.

1. **`docs/.vitepress/config.ts`의 `enSidebar`와 `koSidebar` 양쪽.** 섹션은 독자가 하는 일로 나뉜다. EN은 Get started / Test apps(하위 그룹 QA Session) / Operate(하위 그룹 Set up a Mac / Deploy the relay / Run the team / Deliver builds / AI automation (experimental)) / Reference / Troubleshooting / Contributing, KO는 시작하기 / 앱 테스트(QA 세션) / 운영(Mac 준비 / 릴레이 배포 / 팀 운영 / 빌드 전달 / AI 자동화 (실험적)) / 레퍼런스 / 문제 해결 / 기여. KO 사이드바는 EN과 같은 트리여야 하고 링크에는 `/ko`만 붙는다(테스트가 검사한다).
2. **`docs/public/llms.txt`**: 해당 섹션에 `- [제목](https://www.tapflow.dev/{경로}): {한 줄 설명}` 행을 추가한다. `scripts/__tests__/agentReadableDocs.test.mjs`가 강제하는 것은 다음과 같다.
   - 링크 행의 URL 집합이 `docs/` 아래 영어 `.md` 페이지 전체(`ko/`, `AGENTS.md`/`CLAUDE.md`, `layout: home` 랜딩 제외)와 **정확히 같아야** 한다. 빠져도, 남아도 실패한다.
   - `## ` 섹션 하나가 사이드바 최상위 그룹 하나다. 섹션 이름이 그룹 이름(EN)과 같고, 섹션 안의 링크가 그 그룹의 페이지와 **같은 순서**여야 한다. Operate와 Test apps의 하위 그룹은 `### `로 나눠 쓴다.
   - 모든 URL은 `https://www.tapflow.dev/`로 시작한다(apex `tapflow.dev`는 307 리다이렉트).
   - 설명 문구 자체는 검사하지 않으므로 사람이 맞춘다. frontmatter `description`과 같은 내용으로 쓴다.
   - 확인: `pnpm test:scripts`
3. 파일 경로:

| 위치 | EN | KO |
|---|---|---|
| Get started (튜토리얼·소개) | `docs/get-started/{slug}.md` | `docs/ko/get-started/{slug}.md` |
| Test apps (기능 페이지) | `docs/testing/{slug}.md` | `docs/ko/testing/{slug}.md` |
| Operate (운영자 how-to) | `docs/operate/{slug}.md` | `docs/ko/operate/{slug}.md` |
| AI automation (실험적) | `docs/automation/{slug}.md` | `docs/ko/automation/{slug}.md` |
| 레퍼런스 | `docs/reference/{slug}.md` | `docs/ko/reference/{slug}.md` |
| 문제 해결 | `docs/troubleshooting/{slug}.md` | `docs/ko/troubleshooting/{slug}.md` |

URL 접두사가 곧 섹션이다. slug는 UI 위치가 아니라 대상 이름으로 짓는다. 섹션 개요는 `index.md`가 아니라 형제 파일로 둔다(`docs/testing.md` → `/testing`, `docs/troubleshooting.md` → `/troubleshooting`). `docs/dashboard/`에 남은 `setup.md`는 병합을 기다리는 중이므로 거기에 새 페이지를 두지 않는다.

**페이지를 옮기거나 없앨 때**: 옛 URL을 `docs/.vitepress/moves.json`의 `pages`에 `"옛 경로": "새 경로"`로 추가하고 `node scripts/docs-redirects.mjs --write`로 `docs/vercel.json`을 다시 만든다. 항목 하나가 EN·KO·`.md` 네 개의 308 리다이렉트가 된다. 이미 옮긴 페이지를 또 옮기면 항목을 이어 붙이지 말고 기존 항목의 목적지를 고친다(연쇄 금지). 레포 안의 링크는 새 경로로 고치고, README처럼 이미 배포된 URL은 `docsAnchors`의 `LEGACY_URLS`가 옛 형태 그대로 계속 검사한다. 이 규칙은 `docsMoves` 테스트가 강제한다.

## 6. 미디어

- 정적인 상태(설정 패널, 토글 위치)는 스크린샷으로, 움직임이나 순서가 핵심인 것은 영상으로 보여 준다. 터미널 출력은 이미지 대신 텍스트로 쓴다.
- **위치(필수): 영상(mp4/webm/mov)은 `docs/public/media/`에 두고** 본문에서는 `/media/{파일}`로 가리킨다. `scripts/__tests__/docsMedia.test.mjs`가 강제한다. 이미지는 대상이 아니다. 특히 `docs/public/demo-thumbnail.png`는 옮기지 않는다. npm에 배포된 `packages/cli/README.md`가 raw.githubusercontent.com 주소로 불러오고 `config.ts`의 `og:image`로도 쓰여서, 리다이렉트로 살릴 수 없기 때문이다.
- 권고(검사하지 않음): GIF보다 **짧은 무음 루프 영상 + poster 이미지**를 쓴다. 대략 5~15초, 한 클립에 동작 하나, 깜빡임 없이 만든다. 크기는 클립당 약 2MB 이하를 목표로 한다. 소개·설정 영상(`tapflow-demo.mp4`, `tapflow-setup.mp4`)처럼 성격상 긴 영상은 예외다. 현재 `docs/.vitepress/theme/VideoPlayer.vue`는 `src`/`poster`와 `controls`만 지원한다(muted/loop/autoplay 없음).
- **본문만 읽어도 이해되어야 한다.** 영상이 보여 주는 내용을 옆 문장이 말하고, 단계는 영상 없이도 따라갈 수 있어야 한다.
- 영상을 옮기면 옛 경로를 `docs/.vitepress/moves.json`의 `files`에 추가한다.

## 7. 작성 규칙

한/영 동시 작성(KO가 소스, 구조 일치), 플랫폼 중립 언어, **용어집, 제목, 한 페이지 한 주제(H4 기준), 문장 주체**, 코드블럭 `<placeholder>` 금지, `---` 구분선 금지는 `docs/AGENTS.md`를 따른다. 특히 용어집에 없는 표기를 새로 만들지 않는다.

### 한국어 작성 원칙

- **완전한 문장으로 쓴다.** "수동 업로드 없이."처럼 조각 문장을 독립 문장으로 쓰지 않는다. 앞 문장에 이어 쓰거나 부사절로 처리한다.
- **자연스러운 어순:** 주어 → 부사어 → 서술어 순서를 따른다. `"CI에서 빌드를 올리면 팀원 전체가 App Center에서 바로 확인할 수 있습니다."` ✅  `"팀원 전체가 별도 설치 없이 확인할 수 있습니다. Xcode 없이."` ❌
- **"QA팀" 대신 "팀원", "팀 전체"를 쓴다.** tapflow는 QA만이 아니라 PO, PM, 디자이너, 백엔드 모두가 사용한다.

### 영어 작성 원칙

- Em dash 뒤 단문 처리(`— no manual uploads`)는 영어에서 자연스러우므로 허용한다. KO에서는 조각 문장이 되는 표현이라도 EN em dash 패턴으로는 쓸 수 있다.
- 독자는 KO와 같다. 1절의 유형별 독자를 따른다.

### 두 가지 테스트 경로

수동 테스트를 다루는 문서에서는 AI Agent 경로를 별도 기능으로 구분한다.

```md
::: info Two testing paths
This guide covers the **manual review path**: CI delivers the build; people do the testing.

For automated testing where an LLM agent controls the simulator, see [MCP in CI/CD](/automation/mcp-ci). That is a separate, experimental feature.
:::
```

```md
::: info 두 가지 테스트 경로
이 가이드는 **수동 리뷰 경로**를 다룹니다. CI가 빌드를 전달하고, 팀원이 직접 테스트하는 방식입니다.

LLM 에이전트가 시뮬레이터를 자동으로 조작하는 방식은 [CI/CD에서 MCP 활용](/ko/automation/mcp-ci)을 참고하세요. 이는 별도의 실험적 기능입니다.
:::
```

### 빌드 상태 표현

상태 값(`Backlog` / `In Progress` / `Done` / `Rejected`, `packages/relay/src/api/builds.ts`)의 의미를 설명할 때 아래 문구를 쓴다.

| Status | EN | KO |
|--------|----|----|
| Done | Stakeholders approved | 이해관계자 승인 완료 |
| Rejected | Issues found, needs fixes | 문제 발견, 수정 필요 |
| In Progress | Ready for review | 리뷰 준비 완료 |
| Backlog | Not yet ready | 준비 전 |

### GitHub Actions YAML

`${{ }}` 표현식을 `run:` 스크립트 안에 직접 넣지 않는다. GitHub는 표현식을 먼저 치환한 뒤 스크립트를 셸에 넘기므로, 커밋 메시지나 PR 제목처럼 외부에서 들어오는 값이 셸 명령으로 실행될 수 있다(스크립트 인젝션). 멀티라인 문자열이라면 YAML 들여쓰기도 깨진다.
표현식은 `env:`에서 셸 변수로 먼저 바인딩하고, `run:`에서는 `"$VAR"`처럼 따옴표로 감싸 쓴다.

```yaml
# ❌ 외부 값이 셸 코드로 치환됨 + YAML 들여쓰기 깨짐
-F "body=Branch: ${{ github.ref_name }}
Commit: ${{ github.sha }}"

# ✅ env에서 바인딩 후 $'\n' 처리
env:
  BRANCH: ${{ github.ref_name }}
  COMMIT: ${{ github.sha }}
run: |
  COMMENT="Branch: $BRANCH"$'\n'"Commit: $COMMIT"
```

## 작업 순서

1. 사전 준비 파일 읽기, 모드와 페이지 유형 정하기
2. 소스 대조(작성 전): 사실 목록과 `file:line`
3. KO 작성 → EN 번역(KO 기반)
4. 사실이 바뀌었다면 `docs/` 전체 grep 후 다른 출현도 EN/KO 모두 수정
5. 새 페이지라면 사이드바 EN/KO와 `llms.txt`의 같은 섹션·같은 순서에 등록
6. 소스 대조(작성 후), 그리고 `docs/AGENTS.md` 용어집 대조(산문의 표기가 표와 같은지)
7. `pnpm docs:build`, 새 페이지였다면 `pnpm test:scripts`. 오류가 나면 고치고 다시 돌린다. `#앵커` 링크, EN/KO 헤딩 구조, CLI 플래그와 `cli.md`의 일치는 `pnpm test:scripts`와 cli 테스트가 검사한다(`docsAnchors`, `docsLocaleParity`, `cliDocsParity`).
8. **AI tells detect 게이트**: KO 산문은 `.claude/ai-tells/rules-ko.md`로, EN 산문은 `.claude/ai-tells/rules-en.md`로 `detect`한다. 두 파일의 **docs carve-out**(격식체 종결 균일, glossary 볼드, `~할 수 있습니다` 기능 서술, em dash 단문 closing)을 적용하고, 코드·수치·테이블·frontmatter는 건드리지 않는다.
   - **detect는 게이트일 뿐 자동으로 고치지 않는다. `rewrite`를 자동 호출하지 않는다.** P0/P1(EN)과 S1(KO)을 완료 보고에 적고 **사람 판단**을 받는다. (정책: `/ai-tells` 커맨드 §0)

## 완료 보고

```
## 모드 / 유형
- {새 페이지 | 갱신} / {튜토리얼 | how-to | 기능 | 레퍼런스 | 개념}

## 변경 파일
- docs/ko/...
- docs/...

## 소스 대조
- `tapflow setup` AVD 이미지 android-35 → packages/cli/src/lib/setup.ts:29
- {주장} → {file:line}
- 미확인: {소스에서 못 찾아 쓰지 않은 것 | 없음}

## 용어집 대조
- 표에 없는 표기 {없음 | 목록}, 새로 추가한 용어 행 {없음 | 목록}

## 같은 사실의 다른 출현
- grep "{패턴}" docs/ → {고친 파일 목록 | 없음}

## 등록 (새 페이지)
- config.ts {EN 섹션} > "{EN 레이블}" / {KO 섹션} > "{KO 레이블}"
- llms.txt {섹션} 행 추가

## 빌드·테스트
- pnpm docs:build 통과 / pnpm test:scripts 통과

## AI tells detect (게이트)
- EN: P0/P1 N건 — {인용 또는 "없음(클린)"}
- KO: S1 N건 — {인용 또는 "없음(클린)"}
- 판단이 필요한 항목은 사람이 확인한다(자동 수정 안 함)
```
