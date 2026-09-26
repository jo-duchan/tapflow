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

- 한국어가 소스 언어다. 내용 변경 시 한국어를 먼저 수정하고 영어에 반영한다.
- 새 페이지를 추가할 때는 `docs/ko/`와 `docs/` 양쪽에 파일을 만들고, `config.ts`의 `koSidebar`와 `enSidebar` 모두에 등록한다. `docs/public/llms.txt`에도 사이드바와 같은 섹션·같은 순서로 행을 추가한다(`scripts/__tests__/agentReadableDocs.test.mjs`가 영어 페이지 집합, 섹션 구성, KO 사이드바 대칭을 검사한다). 작성 절차 전체는 `/write-docs` 커맨드에 있다.
- 페이지 URL은 섹션 접두사를 따른다(`/get-started/`, `/testing/`, `/operate/`, `/automation/`, `/reference/`). 페이지를 옮기면 옛 URL을 `.vitepress/moves.json`에 추가하고 `node scripts/docs-redirects.mjs --write`로 `vercel.json`을 다시 만든다. 한 번 렌더된 헤딩 id는 `.vitepress/frozen-ids.json`에 고정되어 있어 없앨 수 없다(`docsMoves` 테스트). 자세한 규칙은 `/write-docs` §4·§5에 있다.
- 내용·구조가 두 버전 간에 일치해야 한다. 한쪽에만 있는 섹션을 만들지 않는다.


## 문서 작성 원칙

### 플랫폼 중립 언어

iOS/Android 양쪽을 지원하는 기능을 설명할 때 특정 플랫폼 도구명을 사용하지 않는다.

| ❌ | ✅ |
|----|-----|
| "no Xcode", "Xcode 설치 없이" | "no IDE", "별도 도구 설치 없이" |
| "Android Studio 불필요" | "개발 환경 설치 없이", IDE |
| `xcodebuild` | (iOS 전용 섹션에서만 허용) |

예외: 해당 섹션이 실제로 iOS 전용 또는 Android 전용인 경우 플랫폼명 명시 가능.

### 용어집

같은 개념은 한 표기로만 쓴다. **산문에만 적용한다.** 코드, 명령어, 설정 키, 파일 경로, 대시보드 UI 라벨은 원문 그대로 둔다(`tapflow relay start`, `relay.url`, **Select device**).

| 개념 | KO 산문 | EN 산문 | 쓰지 않는 표기 |
|---|---|---|---|
| relay | 릴레이 | relay | KO 산문의 `relay`, 리레이 |
| tapflow agent | 에이전트 | agent | KO 산문의 `agent` |
| Claude Code 같은 도구 | 코딩 에이전트 | coding agent | 맥락 없는 "에이전트"/"agent" |
| device | 기기 | device | 디바이스 |
| directory | 디렉터리 | directory | 디렉토리 |
| simulator / emulator | 시뮬레이터 / 에뮬레이터 | simulator / emulator | 시뮬 |
| personal access token | 처음에 "개인 액세스 토큰(PAT)", 이후 PAT | "personal access token (PAT)" first, then PAT | 설명 없는 첫 PAT |
| team member | 팀원, 팀 전체 | teammate, the whole team | QA팀 |

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
