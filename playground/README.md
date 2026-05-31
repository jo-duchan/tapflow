# playground

로컬 통합 테스트 환경. `workspace:*` 심링크로 패키지를 직접 참조하기 때문에 npm 배포 없이 최신 소스를 그대로 실행할 수 있다.

## 로컬 개발

```sh
pnpm dev:up          # relay + ios-agent (Vite dev server 별도 — localhost:3001)
pnpm dev:up:full     # relay + ios-agent + android-agent
pnpm mock-agent      # 시뮬레이터 없이 mock으로 테스트
```

## pre-release 검증 (외부 유저 경험 그대로)

dashboard를 빌드한 뒤 relay가 단독으로 서빙하는 방식 — 실제 설치 사용자가 겪는 경험과 동일하다.

```sh
pnpm pre-release     # dashboard 빌드 → relay 기동
```

브라우저: `http://localhost:4000`

전체 스크립트 목록은 `package.json`의 `scripts` 참고.

## fly.io 배포 (pre-release 테스트 베드)

`Dockerfile` + `fly.toml` + `server.js`는 relay를 fly.io에 배포해 **npm 배포 전** 실제 환경에서 검증하는 용도다.

`workspace:*` 참조 그대로 빌드하기 때문에 현재 소스 상태를 그대로 배포할 수 있다.

```sh
# 모노레포 루트에서 실행
fly deploy . --config playground/fly.toml
```

### 용도

- npm publish 전 버그 검증 (wss 프로토콜, API 동작 등)
- 네트워크 레이턴시 토폴로지 테스트

  | 구성 | 결과 |
  |------|------|
  | browser(로컬) → relay(fly.io) → agent(로컬) | 느림 — agent→relay가 인터넷 경유 |
  | browser(로컬) → relay(로컬 LAN) → agent(로컬) | 정상 |

  **결론**: relay는 반드시 agent와 같은 내부 네트워크에 있어야 한다. fly.io relay는 퀄리티 보장 불가.

### 주의

- `tapflow-relay-test.fly.dev`는 검증 전용 인스턴스다. 팀 운영 환경으로 사용하지 않는다.
- fly.io machine은 트래픽이 없으면 자동으로 중지된다 (`auto_stop_machines = 'stop'`).
