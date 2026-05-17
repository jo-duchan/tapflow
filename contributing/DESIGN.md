# tapflow Dashboard — Design Reference

> 대시보드 구현 기준 디자인 시스템 문서. 색상 토큰, 타이포그래피, 엘리베이션 규칙을 따를 것.
> 새 컴포넌트나 화면을 작성할 때 이 문서를 먼저 확인한다.

---

## Overview

tapflow 대시보드는 **셀프호스팅 QA 도구**의 UI다. Vercel 디자인 시스템에서 영감을 받은 미니멀·모노크롬 포지션을 취한다.

**핵심 특성:**

- **Monochrome-first**: 브랜드 색상이 없다. 잉크-블랙(`#171717`) primary와 회색 계열만으로 UI를 구성한다.
- **Token-driven theming**: 모든 색상은 CSS 변수로만 참조한다. 컴포넌트에 `dark:` 하드코딩 금지.
- **Elevation via shadow**: 카드 계층은 elevation level(0–4)로 표현한다. 단일 헤비 드롭섀도우 금지.
- **Two typefaces**: Inter(산세리프) + JetBrains Mono(모노). 기술 식별자(build_number, bundle_id 등)는 반드시 모노.
- **Negative tracking**: 헤딩 트래킹은 항상 음수. 양수 트래킹, 전체 대문자 금지.

---

## Colors

모든 색상 값은 `src/index.css`의 CSS 변수로 정의된다. Tailwind는 이 변수를 참조한다.

### Surface

| Token | Light hex | Dark hex | 용도 |
|-------|-----------|----------|------|
| `--background` | `#fafafa` | `#171717` | 페이지 배경 |
| `--card` | `#ffffff` | `#1c1c1c` | 카드·팝오버·다이얼로그 표면 |
| `--secondary` / `--muted` / `--accent` | `#f5f5f5` | `#262626` | 인셋 영역, 호버 배경 |

### Text

| Token | Light hex | Dark hex | 용도 |
|-------|-----------|----------|------|
| `--foreground` | `#171717` | `#fafafa` | 기본 본문 텍스트 |
| `--muted-foreground` | `#888888` | `#a6a6a6` | 보조 텍스트, 플레이스홀더 |
| `--sidebar-foreground` | `#4d4d4d` | `#cccccc` | 사이드바 아이템 텍스트 |

### Brand / Interactive

| Token | Light hex | Dark hex | 용도 |
|-------|-----------|----------|------|
| `--primary` | `#171717` | `#fafafa` | 기본 CTA 버튼, 활성 링크 |
| `--primary-foreground` | `#ffffff` | `#171717` | primary 위의 텍스트 |
| `--ring` | `#171717` | `#fafafa` | focus ring |
| `--sidebar-ring` | `#0070f3` | `#0070f3` | 사이드바 focus ring (링크 블루) |

### Semantic

| Token | Light | Dark | 용도 |
|-------|-------|------|------|
| `--destructive` | `0 100% 47%` (~`#ee0000`) | `0 70% 62%` | 파괴적 액션, 에러 상태 |
| `--destructive-foreground` | `#ffffff` | `#fafafa` | destructive 배경 위 텍스트 |

> **Dark mode `--destructive`**: 라이트 `47%`에서 다크 `62%`로 lightness를 올린다. `/10` 배경 투명도 + 텍스트가 모두 가시성을 유지하려면 L ≥ 60% 필요.

### Border / Input

| Token | Light hex | Dark hex | 용도 |
|-------|-----------|----------|------|
| `--border` / `--input` | `#ebebeb` | `#2e2e2e` | 1px 구분선, 입력 테두리 |

### Avatar Palette

이름 해시 기반 6슬롯 색상. `avatarColors(name)` 함수가 CSS 변수를 반환한다.

| Slot | Light bg / fg | Dark bg / fg |
|------|---------------|--------------|
| 1 (rose) | `hsl(353 90% 82%)` / `hsl(353 80% 28%)` | `hsl(353 40% 32%)` / `hsl(353 60% 78%)` |
| 2 (orange) | `hsl(25 100% 76%)` / `hsl(25 90% 25%)` | `hsl(25 42% 32%)` / `hsl(25 65% 78%)` |
| 3 (amber) | `hsl(48 100% 72%)` / `hsl(31 85% 25%)` | `hsl(48 42% 32%)` / `hsl(48 65% 78%)` |
| 4 (green) | `hsl(151 70% 70%)` / `hsl(151 80% 18%)` | `hsl(151 36% 28%)` / `hsl(151 50% 72%)` |
| 5 (blue) | `hsl(216 90% 78%)` / `hsl(216 85% 25%)` | `hsl(216 42% 32%)` / `hsl(216 60% 78%)` |
| 6 (purple) | `hsl(278 75% 84%)` / `hsl(278 75% 28%)` | `hsl(278 38% 32%)` / `hsl(278 55% 78%)` |

아바타 플레이스홀더에는 반드시 `avatarColors(name)`를 사용한다. `bg-muted` 직접 사용 금지.

### Chart Colors

`MacResources` 페이지 Area 차트 전용. 5개 시리즈 색상.

| Token | Light | Dark |
|-------|-------|------|
| `--chart-1` | `216 85% 55%` (blue) | `216 80% 65%` |
| `--chart-2` | `262 65% 58%` (purple) | `262 60% 68%` |
| `--chart-3` | `30 80% 55%` (orange) | `30 75% 65%` |
| `--chart-4` | `151 65% 45%` (green) | `151 60% 55%` |
| `--chart-5` | `340 75% 55%` (pink) | `340 70% 65%` |

---

## Typography

### Font Family

두 가지 폰트만 사용한다.

| 역할 | 패밀리 | 폴백 |
|------|--------|------|
| 기본 산세리프 | Inter (400/500/600) | `ui-sans-serif, system-ui, sans-serif` |
| 모노스페이스 | JetBrains Mono (400) | `ui-monospace, SFMono-Regular, monospace` |

`body`에 `font-feature-settings: 'ss01', 'ss02'`를 전역 적용해 Inter의 기하학적 대안 글리프를 활성화한다.

모노 폰트는 기술 레이어 전용 — 코드 블럭, build_number, bundle_id, UDID 등 기술 식별자. 본문 단락에 모노 사용 금지.

### Letter Spacing Tokens

| Tailwind 클래스 | 값 | 적용 대상 |
|----------------|-----|---------|
| `tracking-display-xl` | `-2.4px` | hero 레벨 헤딩 |
| `tracking-display-lg` | `-1.28px` | 섹션 헤딩 |
| `tracking-display-md` | `-0.96px` | 카드 타이틀 (Login 등) |
| `tracking-display-sm` | `-0.6px` | 소형 디스플레이 헤딩 |
| `tracking-body-sm` | `-0.28px` | 소형 본문 텍스트 |
| `tracking-tight` | Tailwind 기본 | 사이드바 팀 이름, TechLabel |

헤딩 트래킹은 항상 음수를 선택한다. 양수 트래킹, `uppercase` 병용 금지.

### Hierarchy

| 요소 | 클래스 | 용도 |
|------|--------|------|
| 카드 타이틀 | `text-2xl font-semibold tracking-display-md` | Login "Welcome back", 설정 섹션 제목 |
| 본문 강조 | `text-sm font-medium` | 네비게이션 레이블, 버튼 |
| 보조 텍스트 | `text-sm text-muted-foreground` | 카드 description, 캡션 |
| 기술 레이블 | `font-mono text-xs tabular-nums tracking-tight` | build_number, bundle_id (`TechLabel` 컴포넌트) |

---

## Layout

### Spacing

Tailwind 4px base-unit 기반. `p-1`=4px, `p-2`=8px, `p-3`=12px, `p-4`=16px, `p-6`=24px.

카드 내부 패딩: `p-6` (24px) 기본. 밀집 컨텍스트는 `p-4` (16px). 사이드바 영역은 `px-3 py-3` (12px).

### Grid & Container

- 전체 레이아웃: `DashboardLayout` — 좌측 `AppSidebar` + 우측 `main` 영역의 2-column 구조.
- 사이드바: shadcn `Sidebar` (`collapsible="icon"`) — 확장 시 아이콘 + 레이블, 축소 시 아이콘만.
- 콘텐츠 폭: 별도 max-width 없음. 사이드바 너비를 제외한 남은 영역 전체 사용.

### Z-index Layer Tokens

| Tailwind 클래스 | 값 | 용도 |
|----------------|-----|------|
| `z-sidebar` | 10 | 사이드바 |
| `z-tooltip` | 100 | 툴팁 |
| `z-overlay` | 200 | 모달 딤 배경 |
| `z-modal` | 300 | 모달·다이얼로그 콘텐츠 |

raw `z-{n}` 대신 semantic token 클래스를 사용한다.

---

## Elevation & Depth

카드 계층은 `shadow-card-{n}` 토큰으로만 표현한다. 모든 섀도우는 stacked small offsets + inset hairline 구조다.

| Level | Tailwind 클래스 | 섀도우 | 용도 |
|-------|----------------|--------|------|
| 0 | (없음) | 없음 | 전체 밀착 영역, 사이드바 |
| 1 | `shadow-card-1` | inset 1px hairline | 경계만 필요한 flat 카드 |
| 2 | `shadow-card-2` | soft drop + inset | **기본값** — 대부분의 카드 |
| 3 | `shadow-card-3` | stacked drop + inset | feature 카드, 강조 패널 |
| 4 | `shadow-card-4` | float stack + inset | 주요 카드 (Login, pricing 수준) |
| modal | `shadow-modal` | 3-layer + inset | 다이얼로그, 드롭다운 메뉴 |

`Card` 컴포넌트의 `level` prop으로 적용한다:

```tsx
<Card level={2}>기본 카드</Card>
<Card level={4}>Login 카드</Card>
```

---

## Shapes

### Border Radius Scale

| Tailwind 클래스 | 값 | 용도 |
|----------------|-----|------|
| `rounded-sm` | 4px | 배지, 인셋 타이트 요소 |
| `rounded-md` | 6px | 폼 인풋, nav 버튼, 드롭다운 |
| `rounded-lg` | 8px | 카드 (`--radius` 기본값) |
| `rounded-pill` | 100px | 마케팅 스케일 CTA 버튼 (Login Sign in) |
| `rounded-pill-sm` | 64px | 탭 ghost pill |
| `rounded-full` | 9999px | 아이콘 버튼, 아바타 |

---

## Components

### Buttons

6가지 variant + 6가지 size. `components/ui/button.tsx`에 정의.

**Variants:**

| Variant | 스타일 | 용도 |
|---------|--------|------|
| `default` | `bg-primary text-primary-foreground` | 기본 CTA |
| `destructive` | `bg-destructive/10 text-destructive` (soft) | 삭제·탈퇴 액션 |
| `outline` | `border bg-background hover:bg-accent` | 보조 액션 |
| `secondary` | `bg-secondary` | 3순위 액션 |
| `ghost` | 배경 없음, hover만 | 아이콘 버튼, 인라인 액션 |
| `link` | `text-primary underline-offset-4` | 인라인 링크 버튼 |

`destructive`는 solid red fill이 아닌 **soft variant**(반투명 틴트 배경)를 사용한다.

**Sizes:**

| Size | 높이 | 용도 |
|------|------|------|
| `default` | h-10 (40px) | 일반 버튼 |
| `sm` | h-9 (36px) | 폼 submit, 인라인 액션 |
| `lg` | h-11 (44px) | 강조 버튼 |
| `icon` | h-10 w-10 | 정사각 아이콘 버튼 |
| `pill` | h-12 (48px) + `rounded-pill` | 마케팅 스케일 CTA (Login 등) |
| `nav` | h-7 (28px) + `text-xs` | 테이블 인라인, 네비게이션 |

### Cards

`components/ui/card.tsx` — `level` prop으로 elevation 제어.

```tsx
<Card level={1}>  {/* flat */}
<Card level={2}>  {/* 기본, 생략 가능 */}
<Card level={4}>  {/* Login, 주요 진입 화면 */}
```

내부 구성: `CardHeader` (`p-6`) → `CardTitle` + `CardDescription` → `CardContent` (`p-6 pt-0`) → `CardFooter`.

### Inputs & Forms

`components/ui/input.tsx` — `h-10 rounded-md border border-input bg-background`. shadcn 기본.

파일 업로드 입력: "Choose file" 버튼 대신 **현재 이미지 위에 오버레이 pencil 버튼** 패턴 사용. `fileInputRef.current.click()`으로 숨겨진 `<input type="file">`를 연다. 선택 즉시 `URL.createObjectURL`로 미리보기 업데이트.

### Navigation (Sidebar)

`components/app-sidebar.tsx` — shadcn `Sidebar` 기반. 3개 그룹으로 구성:

1. **기본 nav**: App Center, Mac Resources
2. **Settings** (`SidebarGroupLabel`): Default(전체), Team·Tokens(Admin 전용)
3. **Reference** (`SidebarGroupLabel`): Docs 외부 링크

헤더: 팀 로고 + 팀 이름. `/api/v1/settings`에서 fetch. 없으면 기본 logo.svg + "tapflow".  
푸터: `UserAvatar` + 이름/이메일 드롭다운 (Settings, Log out).

### TechLabel

`components/ui/tech-label.tsx` — `font-mono text-xs tabular-nums tracking-tight`.

build_number, bundle_id, UDID, 버전명 등 기술 식별자에 반드시 사용한다.

```tsx
<TechLabel>{build.buildNumber}</TechLabel>
```

### UserAvatar

`components/user-avatar.tsx` — avatarUrl이 있으면 이미지, 없으면 이름 첫 글자 + 해시 색상.

```tsx
<UserAvatar name={user.displayName} avatarUrl={user.avatarUrl} size={28} />
```

아바타 플레이스홀더 색상은 `avatarColors(name)` 함수가 결정한다. `bg-muted` 직접 사용 금지.

### Theme Toggle

`components/theme-toggle.tsx` — `next-themes`의 `useTheme` 기반. 라이트/다크/시스템 3단계.

---

## Do's and Don'ts

### Do

- 색상은 CSS 변수 토큰만 참조 (`bg-background`, `text-foreground`, `border-border`).
- 카드 elevation은 `<Card level={n}>` prop으로.
- 기술 식별자(build_number, UDID 등)는 `<TechLabel>` 컴포넌트로.
- 아바타 플레이스홀더는 `avatarColors(name)`로.
- 헤딩 트래킹은 `tracking-display-*` 토큰 중 하나를 선택.
- Z-index는 `z-sidebar`, `z-modal` 등 semantic token 클래스로.

### Don't

- 컴포넌트에 `dark:bg-gray-900` 형태의 하드코딩 오버라이드 작성 금지.
- `bg-muted`를 아바타 플레이스홀더로 직접 사용 금지.
- 단일 헤비 드롭섀도우 사용 금지 — `shadow-card-{n}` 토큰을 사용할 것.
- 본문 단락에 모노 폰트 사용 금지.
- 헤딩에 `uppercase` + 양수 트래킹 조합 금지.
- raw `z-50`, `z-100` 등 숫자 z-index 직접 사용 금지.

---

## Tapflow Dashboard Design Decisions

구현 과정에서 확립한 패턴. 새 컴포넌트나 화면에서 동일하게 따른다.

### Dark Mode Theming

**Theme via CSS variables only — no `dark:` class overrides in components.**

```css
/* index.css */
:root  { --destructive: 0 100% 47%; }
.dark  { --destructive: 0 70% 62%; }  /* raised lightness so /10 opacity remains visible */
```

컴포넌트는 변수만 참조한다: `bg-destructive/10 text-destructive`. `dark:bg-red-900` 같은 하드코딩은 변수 시스템을 깨므로 금지.

### Destructive Button Style

shadcn v4 기준: **soft variant** — solid red fill이 아닌 반투명 틴트 배경 + 색상 텍스트.

```
bg-destructive/10  text-destructive  hover:bg-destructive/20
```

다크 모드에서 `--destructive`는 L ≥ 60% 이상이어야 `/10` 배경과 텍스트 모두 가시성이 보장된다.

### Avatar Color System

이름 해시 기반 6슬롯 팔레트. **아바타 플레이스홀더에는 반드시 `avatarColors(name)` 사용** — `bg-muted` 직접 사용 금지.

```ts
// components/user-avatar.tsx
export function avatarColors(name: string): { bg: string; fg: string }
```

색상은 CSS 변수(`--avatar-1-bg` … `--avatar-6-fg`)로 정의. 라이트/다크 각각:
- **Light**: vibrant pastels (lightness ~70–84%)
- **Dark**: 같은 hue, 채도·밝기 낮춤 (~28–32%)

### Image Input Pattern (Avatar / Logo)

"Choose file" 버튼 대신 **현재 이미지 우하단에 pencil 버튼 오버레이** 패턴.

```tsx
<div className="relative w-14 h-14">
  {/* current image or initials placeholder */}
  <button
    type="button"
    onClick={() => fileInputRef.current?.click()}
    className="absolute bottom-0 right-0 w-6 h-6 rounded-full bg-background border border-border shadow-sm flex items-center justify-center hover:bg-accent transition-colors"
  >
    <Pencil className="w-3 h-3" />
  </button>
  <input ref={fileInputRef} type="file" className="hidden" />
</div>
```

파일 선택 시 `URL.createObjectURL`로 즉시 미리보기 업데이트.

### Button Press Feedback

`translateY(1px)` press 효과를 `index.css` base layer에서 전역 적용 — 컴포넌트에 개별 작성 금지.

```css
button:not([aria-haspopup]):not(:disabled),
[role="button"]:not([aria-haspopup]):not(:disabled) {
  transition-property: color, background-color, border-color, transform;
  transition-duration: 120ms;
}
button:active:not([aria-haspopup]):not(:disabled) {
  transform: translateY(1px);
}
```

`aria-haspopup` 요소(Select, DropdownMenu 트리거 등)는 오버레이 열릴 때 시각 글리치 방지를 위해 제외.

### Button Size Guidelines

| 컨텍스트 | size |
|---------|------|
| 폼 submit (Settings 등) | `sm` (h-9) |
| 리스트 인라인 액션 | `sm` |
| 네비게이션·테이블 인라인 | `nav` (h-7) |
| 주요 CTA (Login, 마케팅 등) | `pill` (h-12) |
