# playground — CLAUDE.md

> 공통 규칙: [CLAUDE.md](../CLAUDE.md) | 전체 인덱스: [INDEX.md](../INDEX.md)

---

## WHAT

로컬 전체 스택 테스트 환경. 실제 패키지를 npm workspaces symlink로 참조해 구현 전 API 설계 검증 및 구현 후 통합 테스트에 사용한다.

## HOW

### 가장 빠른 시작 (CLI)

> **주의**: CLI는 아직 npm에 배포되지 않았다. `tapflow` 커맨드를 쓰려면 먼저 빌드해야 한다.
> 빌드 없이 실행하려면 `tsx ../packages/cli/src/index.ts <command>` 를 사용한다.

```bash
# 빌드 후 사용
pnpm --filter @tapflowio/cli build
tapflow start                           # relay + agent 한 번에 기동
tapflow start --device "iPhone 16"     # 디바이스 지정
tapflow start --relay ws://remote:3000  # 외부 relay 사용

# 빌드 없이 소스에서 직접 실행
tsx ../packages/cli/src/index.ts start
tsx ../packages/cli/src/index.ts start --device "iPhone 16"
# 브라우저 → http://localhost:4000
```

### pre-release 검증 (외부 유저 경험과 동일)

dashboard 빌드 후 relay가 단독 서빙 — 실제 설치 사용자가 겪는 흐름을 그대로 재현한다.

```bash
pnpm pre-release   # dashboard 빌드 → relay 기동 → localhost:4000
```

### Playground 스크립트 (개발·디버깅용)

dashboard 소스를 수정하면서 HMR로 빠르게 확인할 때 사용한다. relay API는 4000, dashboard는 3001(Vite dev server).

```bash
pnpm dev:up        # relay + ios-agent를 concurrently로 기동
pnpm dev:up:full   # relay + ios-agent + android-agent 동시 기동 (Mac 풀 구동)

pnpm relay                              # 릴레이 단독
pnpm ios-agent                          # 첫 번째 booted 시뮬레이터
pnpm ios-agent -- --device "iPhone 16" # 디바이스 지정
pnpm android-agent
pnpm mock-agent                         # 시뮬레이터 없이 테스트할 때 사용하는 mock 에이전트
TAPFLOW_TOKEN=<pat> pnpm mcp            # MCP 서버 (빌드 없이 소스에서 직접 실행)
```

### 진단 · 초기화

```bash
pnpm dev:doctor    # 시스템 상태 점검 (tapflow doctor와 동일)
pnpm dev:reset     # 시뮬레이터 전체 shutdown (tapflow reset과 동일)
```

환경변수로 포트·릴레이 URL 오버라이드 가능.
```bash
PORT=4000 pnpm relay
RELAY_URL=ws://localhost:4000 pnpm ios-agent
```

## HOW NOT

- 이 디렉토리 코드를 패키지 소스로 import하지 않는다 — 단방향 참조.
- playground 코드를 `packages/`에 복사하지 않는다.
- 실제 디바이스 자격증명·토큰을 스크립트에 하드코딩하지 않는다.
