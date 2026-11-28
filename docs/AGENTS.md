---
type: rules
topics: [docs, vitepress, contributing]
status: living
---

# docs — AGENTS.md

VitePress 1.x 기반 정적 문서 사이트. 작업하면서 겪은 삽질과 확인된 동작을 기록한다.


## 파일 구조

VitePress 표준 구조를 따른다. 사이드바·shiki 테마 주입은 `.vitepress/config.ts`, CSS 커스터마이징과 shiki 커스텀 테마는 `.vitepress/theme/`에 있다. 문서 본문은 영어가 `docs/`, 한국어가 `docs/ko/`. 페이지 이동 기록(리다이렉트의 원본)은 `.vitepress/moves.json`에, 영상은 `public/media/`에 둔다.


## 문서 작성 규칙

### 한/영 동시 작성 필수

모든 문서는 한국어(`docs/ko/`)와 영어(`docs/`) 두 버전을 함께 작성한다.

- 영어가 원본이다(2026-11-29부터). 내용을 바꿀 때는 영어를 먼저 고치고 한국어로 옮긴다. 한국어는 문장 단위로 옮기지 않고, 뜻을 지킨 채 한국어 어순과 호흡으로 다시 쓴다. 번역투는 `/ai-tells ko detect`로 확인한다.
- 메인테이너는 이 번역을 Codex(`gpt-6.1-terra`)에 맡기고 결과를 사람과 함께 검토한다. 번역 브리프에는 용어집, 아래 문장 원칙, 링크 글자로 쓸 한국어 페이지 제목을 넣는다. Codex가 없으면 직접 옮기면 된다.
- 새 페이지를 추가할 때는 `docs/ko/`와 `docs/` 양쪽에 파일을 만들고, `config.ts`의 `koSidebar`와 `enSidebar` 모두에 등록한다. `docs/public/llms.txt`에도 사이드바와 같은 섹션·같은 순서로 행을 추가한다(`scripts/__tests__/agentReadableDocs.test.mjs`가 영어 페이지 집합, 섹션 구성, KO 사이드바 대칭을 검사한다). 작성 절차 전체는 `/write-docs` 커맨드에 있다.
- 페이지 URL은 섹션 접두사를 따른다(`/get-started/`, `/testing/`, `/ai-agents/`, `/automation/`, `/operate/`, `/reference/`, `/troubleshooting/`). `/testing/`·`/ai-agents/`·`/automation/`은 세 쓰임(수동 QA, AI 에이전트 QA, 자동화 QA) 섹션이다. 페이지를 옮기면 옛 URL을 `.vitepress/moves.json`에 추가하고 `node scripts/docs-redirects.mjs --write`로 `vercel.json`을 다시 만든다. 한 번 렌더된 헤딩 id는 `.vitepress/frozen-ids.json`에 고정되어 있어 없앨 수 없다(`docsMoves` 테스트). 자세한 규칙은 `/write-docs` §4·§5에 있다.
- 내용·구조가 두 버전 간에 일치해야 한다. 한쪽에만 있는 섹션을 만들지 않는다.


### 문서는 릴리스 때 공개된다

tapflow.dev는 `main`이 아니라 `docs-production` 브랜치에서 배포되고, 그 브랜치는 릴리스 태그를 따라간다.
그래서 여기서 머지한 문서는 다음 릴리스 때 사이트에 나오고, 그 전에는 `main`의 Vercel Preview에서만 보인다.
미발행 기능을 미리 문서에 적어도 되는 건 이 때문이다.

이미 발행된 기능의 문서 오류는 릴리스를 기다리지 않고 내보낼 수 있다. 절차(체리픽)는 CONTRIBUTING.md의
"Docs follow releases"에 있다.

## 문서 작성 원칙

### 플랫폼 중립 언어

iOS/Android 양쪽을 지원하는 기능을 설명할 때 특정 플랫폼 도구명을 사용하지 않는다.

| ❌ | ✅ |
|----|-----|
| "no Xcode", "Xcode 설치 없이" | "no IDE", "별도 도구 설치 없이" |
| "Android Studio 불필요" | "개발 환경 설치 없이", IDE |
| `xcodebuild` | (iOS 전용 섹션에서만 허용) |

예외: 해당 섹션이 실제로 iOS 전용 또는 Android 전용인 경우 플랫폼명 명시 가능.

### 배지와 페이지 상태

- **플랫폼 배지는 한쪽 전용일 때만 단다.** 기본은 양쪽 지원이고 차이는 각 기능 페이지의 Platform support 표가 말한다. 문구는 `iOS only`/`Android only`, KO `iOS 전용`/`Android 전용`뿐이다. 맨 `iOS`는 '지원'으로 읽혀서 쓰지 않는다.
- **실험적·지원 중단 예정은 frontmatter `status` 하나로 표시한다**(`experimental`, 또는 `deprecated` + `replacedBy: /경로`). 배너·사이드바 배지·`llms-full.txt`가 여기서 만들어지므로 경고 박스를 손으로 쓰지 않는다. 형식은 `/write-docs` §3, 상태의 뜻은 Introduction의 `#page-status`.
- 정식 페이지 안의 실험적 절은 H2 아래 `<Badge type="warning" text="Experimental" />`(KO `실험적`)를 단다.
- 위 문구 밖의 `<Badge>`와 frontmatter와 맞지 않는 `llms.txt` 행은 `scripts/__tests__/pageStatus.test.mjs`가 막는다.

### 용어집

같은 개념은 한 표기로만 쓴다. **산문에만 적용한다.** 코드, 명령어, 설정 키, 파일 경로, 대시보드 UI 라벨은 원문 그대로 둔다(`tapflow relay start`, `relay.url`, **Select device**).

| 개념 | KO 산문 | EN 산문 | 쓰지 않는 표기 |
|---|---|---|---|
| relay | 릴레이 | relay | KO 산문의 `relay`, 리레이 |
| tapflow agent: 시뮬레이터·에뮬레이터를 띄우는 프로세스. 보통 Mac, Android만이면 Windows도(커뮤니티 지원) | 에이전트 | agent | KO 산문의 `agent`, 정의에서 Mac에만 한정하는 표현 |
| Claude Code처럼 MCP로 기기를 조작하는 AI 도구, 그리고 그 쓰임과 기능의 이름 | AI 에이전트(AI 에이전트 QA, AI 에이전트 Flow Capture) | AI agent (AI Agent QA, AI Agent Flow Capture) | "코딩 에이전트"/"coding agent", 맥락 없는 "에이전트"/"agent", 쓰임 이름으로서 "에이전트 QA", "Agents"(tapflow agent와 혼동). 예외: `tapflow init`이 쓰는 AGENTS.md를 읽는 도구는 "코딩 에이전트"(CLI 출력 문구와 같게, `docsGlossary`가 허용 목록으로 지킴) |
| a flow's step (and a captured step) | 단계 | step | KO 산문의 "스텝" |
| device | 기기 | device | 디바이스 |
| directory | 디렉터리 | directory | 디렉토리 |
| simulator / emulator | 시뮬레이터 / 에뮬레이터 | simulator / emulator | 시뮬 |
| personal access token | 처음에 "개인 액세스 토큰(PAT)", 이후 PAT | "personal access token (PAT)" first, then PAT | 설명 없는 첫 PAT |
| team member | 팀원, 팀 전체 | teammate, the whole team | QA팀 |
| the person who sets up and runs tapflow (installs it, keeps the relay and agents running). Not a role: the first account is an Admin, but any Admin can invite, and an Admin need not be the operator | 운영자 | operator | "운영자(Admin)", "an operator (Admin)"처럼 역할과 같다고 쓰는 표기 |
| the machine the relay runs on (Mac, Linux or Docker host) | 릴레이 호스트 | relay host | 릴레이가 Mac이 아닐 수 있는 문맥의 "릴레이 Mac", "the Mac the relay runs on" |
| comment on a build | 댓글 | comment | 코멘트 |
| pinch (two-finger zoom) | 핀치 | pinch | 꼬집기, 핀치 줌 |
| long press | 길게 누르기 | long press, hold | 롱프레스, 롱 프레스, 롱탭 |
| deep link | 딥 링크 | deep link | KO 산문의 "딥링크" (UI 라벨 **Open a deeplink**, **Deeplink URL**은 그대로) |
| dashboard token Type **API** (`view, builds:write`) | API 유형 토큰(또는 API 유형 PAT), 스코프를 괄호로 한 번 병기 | API-type token (or API-type PAT), scopes in parentheses once | "view-scope PAT", "API 토큰", 스코프 없는 "PAT"만으로 종류 지시 |

- 약어는 페이지에서 처음 나올 때 풀어 쓴다(AVD, PAT, TLS 등). 업계에서 그대로 쓰는 약어(API, URL, CI)는 예외다.
- 새 용어가 두 번 이상 나오면 이 표에 행을 추가한다.
- 기존 헤딩의 표기를 바꿀 때는 앵커가 깨지지 않게 원래 id를 `{#기존-id}`로 명시한다.

### 제목

- 핵심 키워드를 넣고 30자 안으로 쓴다.
- 평서문으로 쓴다. 질문형("~하려면?")이나 조건절로 끝나는 제목("~에 도달하려면")은 쓰지 않는다.
- 같은 층의 제목은 같은 형태로 맞춘다. 작업 단위 how-to의 H2는 "무엇을 한다"(`## 빌드 업로드`)처럼, 레퍼런스의 H2는 대상 이름(`## tapflow doctor`)으로 쓴다.
- 이 규칙은 새 제목에 적용한다. 기존 제목은 앵커 때문에 함부로 바꾸지 않는다.

### 한 페이지에는 주제 하나

- 제목이 `####`(H4)까지 내려가면 페이지를 나눌 신호로 본다. H3까지만 쓴다.
- 여러 기능을 한 페이지에서 소개해야 하면, 개요 페이지를 두고 각 기능 페이지로 링크한다(표 한 칸에 기능 설명을 몰아넣지 않는다).

### 문장

- **독자를 주어로 쓴다.** "이 명령은 기기를 초기화합니다"보다 "이 명령을 실행하면 기기를 초기화할 수 있습니다"처럼 독자가 할 수 있는 일을 중심으로 쓴다. 도구가 어떻게 동작하는지 설명할 때만 도구를 주어로 둔다.
- 능동형으로 쓴다.
- 메타 담화("이 절에서는 ~를 설명합니다")를 쓰지 않는다. 바로 내용으로 들어간다.
- "빠르게", "적당히" 대신 수치나 기준을 쓴다(5분, 1280px, 기본 4000번 포트).
- **기능이 가능하게 하는 일은 단정하지 않는다.** "AI 에이전트는 기기를 조작해 앱을 테스트합니다"가 아니라 "테스트할 수 있습니다"로 쓴다.
- **개요의 첫 문단은 정의 → 동작 → 대상 순서로 쓴다.** "AI 에이전트 QA는 ~하는 방식입니다. AI 에이전트는 MCP 서버로 화면을 읽고 탭과 입력을 보냅니다. 이 기기는 팀원이 QA 세션에서 쓰는 것과 같은 시뮬레이터와 에뮬레이터입니다."
- **처음 보는 독자가 이유를 모를 문장은 쓰지 않는다.** 문서를 만들며 내린 결정의 흔적(왜 이 페이지에는 상태 배너가 없는지 등)을 본문에 남기지 않는다.
- **절차는 실제 순서대로 쓴다.** "MCP 서버를 설치하고 AI 에이전트에 연결합니다"보다 "npm으로 설치하고 AI 에이전트의 MCP 설정에 등록합니다. 이때 릴레이 주소와 토큰을 넣습니다"처럼 쓴다.
- **역할 표는 역할마다 할 일이 다를 때만 둔다.** "링크를 열어 지켜본다"처럼 선택 사항뿐인 역할은 표에 넣지 않는다.
- **문장마다 누가 하는지가 분명해야 한다.** 번역에서 주어가 흐려지기 쉬우니 검토할 때 따로 본다.

제목·페이지 분할·문장 원칙은 토스 [technical-writing](https://github.com/toss/technical-writing) 가이드의 Step 2·3을 참고해 tapflow에 맞게 다시 썼다. 원문(CC BY-NC-SA 4.0)을 옮기지 않고 원칙만 가져왔다. docs 말투는 우리 규칙대로 합니다체를 유지한다.


## 확인된 동작 및 주의사항

### 1. sh/bash 코드블럭에서 `<placeholder>` 사용 금지

shiki의 sh/bash TextMate grammar은 `<url>`, `<port>`, `<name>` 등 angle bracket을 **HTML 태그**로 토크나이즈한다.
`<url>` → `<ur` = `entity.name.tag` (초록), `l` = 일반 텍스트 (검정) → 색이 깨진다.

**커뮤니티 컨벤션** (Vite, VitePress, Vitest 공식 docs 동일):
- `sh` 코드블럭: 실행 가능한 커맨드 형태만. 옵션은 생략.
- `<placeholder>` 표기: 테이블 셀 인라인 코드로만 사용.

```md
<!-- ❌ -->
```sh
tapflow status [--relay <url>]
```

<!-- ✅ -->
```sh
tapflow status
```

| Option | Description |
|--------|-------------|
| `--relay <url>` | Relay URL |
```

---

### 2. `.VPNav` background-color 직접 지정 금지

VitePress는 `--vp-nav-bg-color: var(--vp-c-bg)` 로 nav 배경을 내부에서 처리한다.
`.VPNav`에 `background-color`를 명시하면 VitePress 내부 스타일과 충돌해 의도치 않은 레이어 문제가 생긴다.

배경색은 `--vp-c-bg` 변수만 조정한다.

---

### 3. 다크 모드 구분선(divider-line) 보이지 않는 문제

VitePress 기본값 `--vp-c-gutter: #000000` (dark)이 우리 배경 `#0a0a0a`에서 안 보인다.

```css
/* custom.css */
.dark {
  --vp-c-gutter: #2a2a2a;
}
```

---

### 4. `--vp-c-brand-1` 변경 시 UI 컨트롤 오염

`--vp-c-brand-1` 을 바꾸면 nav active, sidebar active, next page link뿐 아니라
**Search 입력창 border, dark mode Switch hover border** 도 같이 바뀐다.

UI 컨트롤 border를 브랜드 색이 아닌 텍스트 색으로 유지하려면 별도 오버라이드 필요:

```css
.VPSwitch:hover { border-color: var(--vp-c-text-1) !important; }
.search-bar:focus-within { border-color: var(--vp-c-text-1) !important; }
.DocSearch-Form { border-color: var(--vp-c-text-2) !important; }
.DocSearch-Button:hover { border-color: var(--vp-c-text-1) !important; }
```

---

### 5. 사이드바 level-1 active indicator

VitePress CSS는 기본적으로 level-2 이상에만 `.indicator` 활성화 스타일을 적용한다.
level-1 항목에도 표시하려면 명시적으로 추가해야 한다.

```css
.VPSidebarItem.level-1.is-active > .item > .indicator {
  background-color: var(--vp-c-brand-1);
}
```

---

### 6. 헤딩 안 인라인 코드 폰트 불일치

`h1`/`h2`/`h3` 안의 `` `code` `` 는 기본적으로 모노폰트·코드 색상이 적용되어 헤딩과 이질감이 생긴다.

```css
.vp-doc h1 code,
.vp-doc h2 code,
.vp-doc h3 code {
  font-family: inherit;
  font-size: 0.95em;
  font-weight: 600;
  color: inherit;
  letter-spacing: inherit;
}
```

---

### 7. 섹션 구분에 `---` 사용 금지

VitePress는 `h2`에 기본으로 `border-top: 1px solid var(--vp-c-divider)`를 적용한다.
`---`(`<hr>`)를 h2 앞에 쓰면 `<hr>` + h2 border-top이 겹쳐 구분선이 두 줄로 렌더링된다.

- ❌ 섹션 사이에 `---` 추가
- ✅ `---` 없이 `## Section` 바로 작성 — h2 border-top이 구분선 역할을 함

기존 파일을 편집할 때 `---`가 있으면 제거한다. 다른 docs 페이지(`ios-agent.md`, `quick-start.md` 등)는 모두 `---`를 쓰지 않는다.

---

### 8. 코드블럭 `.line` span의 display

`.line` span에 `display: block` 을 주면 `<pre>` 안의 `\n` 텍스트 노드와 겹쳐 빈 줄이 생기고 코드블럭 높이가 깨진다.
`display: inline-block; width: 100%` 을 사용한다.

```css
.vp-doc div[class*='language-'] pre code .line {
  display: inline-block;
  width: 100%;
}
```
