# docs — CLAUDE.md

VitePress 1.x 기반 정적 문서 사이트. 작업하면서 겪은 삽질과 확인된 동작을 기록한다.

---

## 파일 구조

```
docs/
├── .vitepress/
│   ├── config.ts              # VitePress 설정 (shiki 테마 주입 등)
│   └── theme/
│       ├── index.ts           # 테마 진입점
│       ├── custom.css         # CSS 커스터마이징
│       ├── tapflow-light.json # shiki 커스텀 테마 (라이트)
│       └── tapflow-dark.json  # shiki 커스텀 테마 (다크)
└── reference/
    └── cli.md                 # CLI 레퍼런스
```

---

## 문서 작성 규칙

### 한/영 동시 작성 필수

모든 문서는 한국어(`docs/ko/`)와 영어(`docs/`) 두 버전을 함께 작성한다.

- 한국어가 소스 언어다. 내용 변경 시 한국어를 먼저 수정하고 영어에 반영한다.
- 새 페이지를 추가할 때는 `docs/ko/`와 `docs/` 양쪽에 파일을 만들고, `config.ts`의 `koSidebar`와 `enSidebar` 모두에 등록한다.
- 내용·구조가 두 버전 간에 일치해야 한다. 한쪽에만 있는 섹션을 만들지 않는다.

---

## 문서 작성 원칙

### 플랫폼 중립 언어

iOS/Android 양쪽을 지원하는 기능을 설명할 때 특정 플랫폼 도구명을 사용하지 않는다.

- ❌ "no Xcode", "Xcode 설치 없이", "Android Studio 불필요"
- ✅ "no IDE", "별도 도구 설치 없이", "개발 환경 설치 없이"

예외: 해당 섹션이 실제로 iOS 전용 또는 Android 전용인 경우 플랫폼명 명시 가능.

---

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

기존 파일을 편집할 때 `---`가 있으면 제거한다. 다른 docs 페이지(`ios-agent.md`, `getting-started.md` 등)는 모두 `---`를 쓰지 않는다.

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
