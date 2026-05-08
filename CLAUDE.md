# tapflow — CLAUDE.md (Common Rules)

> 패키지별 규칙은 [INDEX.md](./INDEX.md)를 통해 참조한다.

---

## WHAT

tapflow는 QA팀이 iOS/Android 시뮬레이터·에뮬레이터를 브라우저에서 직접 조작할 수 있게 해주는 **오픈소스 셀프호스팅 라이브러리**다.
외부 클라우드 의존 없이 팀의 Mac/Linux를 그대로 서버로 쓴다.

---

## WHY

- Appetize·BrowserStack은 비싸고 앱 데이터가 외부로 나간다.
- 개발자가 이미 보유한 인프라(Mac, Linux)를 재활용한다.
- 완전 오픈소스로 커스터마이징이 가능하다.

---

## WHERE

```
packages/
  agent-core/    # DeviceAgent 인터페이스 + AgentRegistry
  ios-agent/     # xcrun simctl + WebDriverAgent
  android-agent/ # ADB 래퍼
  relay/         # WebSocket 릴레이 서버
  dashboard/     # Next.js QA 대시보드
  cli/           # npx tapflow CLI
docs/PRD.md      # 제품 요구사항 문서
```

---

## HOW

### 언어·스택
- 전 패키지 TypeScript. `any` 사용 금지.
- Node.js ≥ 20. `ws` for WebSocket, `next` for dashboard.
- 테스트: vitest.

### 브랜치 전략

```
main          ← 항상 배포 가능한 상태. 직접 커밋 금지.
└── feature/{topic}   ← 모든 작업은 feature 브랜치에서 시작
    └── PR → main merge
```

- 브랜치명: `feature/{topic}` (예: `feature/60fps-streaming`)
- PR 없이 main에 직접 push하지 않는다.
- dev 브랜치는 더 이상 사용하지 않는다.

### 워크플로우 (Plan → Work → Review → Compound)

각 작업은 `.work/`에 기록한다. 컨벤션: [.work/CLAUDE.md](./.work/CLAUDE.md).

**1. Plan** — 작업 시작 전 요구사항과 테스트 케이스를 먼저 정의한다. (`type: plan`)

**2. Work** — feature 브랜치에서 테스트를 먼저 작성하고, 테스트가 통과할 때까지 구현을 반복한다.
```
git checkout -b feature/{topic}
write test → implement → run test → fix → repeat
```

**3. Review** — 엣지 케이스 테스트를 추가하고 실제 데이터로 검증한다. PR을 열어 리뷰 후 main에 merge한다. (`type: review`)

**4. Compound** — 테스트 + 코드 + 프롬프트를 묶어 템플릿화한다. 반복 작업을 자산으로 축적한다. (`type: compound`)

커스텀 커맨드: `/work-plan {topic}` (Opus로 plan 문서 생성) · `/compound` (기존 문서 또는 CLAUDE.md에 패턴 추가)

### 커밋 메시지 (Conventional Commits)

```
<type>(<scope>): <subject>
```

**type**

| type | 용도 |
|------|------|
| `feat` | 새 기능 |
| `fix` | 버그 수정 |
| `test` | 테스트 추가·수정 |
| `refactor` | 동작 변경 없는 코드 개선 |
| `docs` | 문서 변경 |
| `chore` | 빌드·의존성·설정 변경 |
| `perf` | 성능 개선 |

**scope** — 변경된 패키지명을 사용한다.
`agent-core` · `ios-agent` · `android-agent` · `relay` · `dashboard` · `cli` · `playground`

**예시**
```
feat(agent-core): add DeviceAgent interface and AgentRegistry
feat(ios-agent): implement xcrun simctl listDevices
fix(relay): handle agent disconnection gracefully
test(ios-agent): add unit tests for boot command
chore(deps): update ws to v8.18
```

### 코드 규칙
- 주석은 WHY가 명확히 비자명한 경우에만 한 줄 작성.
- 인터페이스 변경 시 `agent-core`를 먼저 수정하고 구현체를 맞춘다.
- 새 플랫폼은 `AgentRegistry.register()`만으로 추가한다. 릴레이/대시보드 코드를 건드리지 않는다.

### 설계 원칙 (SOLID 중 우선 적용)
확장 가능하고 교체 가능한 구조를 위해 아래 세 원칙을 우선 준수한다.

- **OCP** (Open/Closed): 새 플랫폼·기능은 기존 코드 수정 없이 추가한다. `AgentRegistry.register()`가 대표 사례.
- **ISP** (Interface Segregation): `DeviceAgent` 인터페이스는 모든 플랫폼이 구현 가능한 메서드만 포함한다. 플랫폼 특화 기능은 별도 인터페이스로 분리한다.
- **DIP** (Dependency Inversion): 의존성은 생성자 주입으로 받는다. 구현체가 아닌 인터페이스에 의존해 테스트 시 mock 교체가 가능하게 한다.

---

## HOW NOT

- 앱 데이터·스트림을 외부 서비스로 전송하는 코드를 작성하지 않는다.
- 로드맵에 없는 기능을 선제적으로 추가하지 않는다.
- `agent-core` 인터페이스를 플랫폼 특화 로직으로 오염시키지 않는다.
- 테스트 없이 구현 코드를 먼저 작성하지 않는다.
