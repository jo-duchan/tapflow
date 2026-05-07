# tapflow

**Product Requirements & Technical Design**  
버전 0.2 · 2026-05-07 · Draft

---

## 1. 개요

### 1.1 제품 비전

tapflow는 iOS/Android QA팀이 시뮬레이터·에뮬레이터를 브라우저에서 직접 실행할 수 있게 해주는 오픈소스 라이브러리다. 별도의 클라우드 인프라 없이 개발자의 Mac을 iOS 서버로, Linux 머신을 Android 서버로 활용하며, 릴레이 서버도 팀이 직접 셀프호스팅한다.

### 1.2 핵심 가치

| 가치 | 설명 |
|------|------|
| Zero infra cost | 유저가 이미 보유한 Mac/Linux를 서버로 활용 |
| Zero data leak | 앱과 데이터가 외부 클라우드로 나가지 않음 |
| Zero config | `npx tapflow deploy` 한 줄로 릴레이 서버 배포 |
| Multi-platform | iOS(Mac), Android(Linux) 동일 인터페이스로 지원 |
| Open source | 완전 오픈소스, 커스터마이징 가능 |

### 1.3 타겟 유저

- iOS/Android 앱을 개발하는 스타트업·중소 팀
- QA팀이 별도로 있으나 디바이스·인프라 비용을 줄이고 싶은 팀
- 앱 데이터 보안이 중요한 엔터프라이즈 팀

---

## 2. 문제 정의

현재 iOS/Android QA를 위한 선택지와 한계:

| 방법 | 문제점 |
|------|--------|
| 실물 디바이스 지급 | 비용, 분실·관리 부담 |
| appetize.io | 월 $59~$319, 앱이 외부 서버로 업로드됨 |
| BrowserStack | 고가, 무료 플랜 없음 |
| Xcode 시뮬레이터 직접 | QA팀이 Mac/Xcode 직접 설치 필요 |
| ios-bridge (오픈소스) | LAN 수준 접속, 유지보수 불확실 (Star 42) |
| baguette (오픈소스) | iOS 26 전용, 팀 협업 레이어 없음 |

tapflow가 해결하는 것: 개발자 Mac·Linux의 시뮬레이터/에뮬레이터를 QA팀이 브라우저에서 안전하게 접근할 수 있게 하고, 팀 워크플로우(버그 리포트, 세션 공유, 테스트 케이스)까지 제공한다.

---

## 3. 아키텍처

### 3.1 전체 구조

```
┌─────────────────────────────────────────────────────────┐
│              QA팀 (브라우저)                             │
│    WebRTC/MJPEG 스트림 수신 + 터치 이벤트 전송           │
└──────────────────┬──────────────────────────────────────┘
                   │ WebSocket / WebRTC
┌──────────────────▼──────────────────────────────────────┐
│     릴레이 서버 (팀이 npx tapflow deploy로 배포)         │
│    NAT 통과 · 세션 라우팅 · 인증/초대 관리               │
└──────────────────┬──────────────────────────────────────┘
                   │ WebSocket 터널 (outbound)
┌──────────────────▼──────────────────────────────────────┐
│           DeviceAgent (플랫폼별 구현)                    │
│  ┌─────────────────┐    ┌─────────────────────────┐    │
│  │  IOSAgent       │    │  AndroidAgent           │    │
│  │  Mac 필요       │    │  Linux/Mac/Win 가능     │    │
│  │  xcrun simctl   │    │  ADB + Android Emu      │    │
│  │  WebDriverAgent │    │  adb shell input        │    │
│  └─────────────────┘    └─────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

### 3.2 컴포넌트 역할

| 컴포넌트 | 역할 | 기술 스택 |
|---------|------|----------|
| DeviceAgent (iOS) | 시뮬레이터 제어, 화면 캡처, 터치 인젝션 | Node.js + xcrun simctl + WebDriverAgent |
| DeviceAgent (Android) | 에뮬레이터 제어, ADB 래핑 | Node.js + ADB |
| 릴레이 서버 | NAT 통과, 세션 라우팅, JWT 인증 | Node.js + ws |
| Web Dashboard | QA팀 UI, 세션 뷰어, 테스트 관리 | Next.js + TypeScript |
| CLI (tapflow) | 릴레이 배포, Agent 설정, 팀 관리 | Node.js CLI + Pulumi |

### 3.3 플랫폼별 인프라 요구사항

| 플랫폼 | 필요 OS | 클라우드 실행 | 제어 도구 | Agent 비용 |
|-------|--------|------------|---------|----------|
| iOS | macOS 필수 (Apple 정책) | ❌ Mac 인스턴스 필요 | xcrun simctl + WDA | Mac Mini 중고 $300~ |
| Android | Linux/Mac/Windows 모두 | ✅ EC2 t3.medium 가능 | ADB + Android Emulator | ~$30/월 클라우드 |

---

## 4. DeviceAgent 상세 설계

### 4.1 공통 인터페이스

릴레이 서버와 Web Dashboard는 플랫폼을 모른다. DeviceAgent 인터페이스만 바라본다.

```typescript
interface DeviceAgent {
  boot(deviceId: string): Promise<void>
  shutdown(deviceId: string): Promise<void>
  installApp(path: string): Promise<void>
  launchApp(bundleId: string): Promise<void>
  screenshot(): Promise<Buffer>
  stream(): ReadableStream           // MJPEG or H.264
  tap(x: number, y: number): Promise<void>
  swipe(from: Point, to: Point): Promise<void>
  type(text: string): Promise<void>
  listDevices(): Promise<Device[]>
}
```

### 4.2 IOSAgent

**시뮬레이터 제어**
```bash
xcrun simctl boot 'iPhone 15 Pro'
xcrun simctl install booted MyApp.app
xcrun simctl launch booted com.example.app
```

**화면 스트리밍**

| 단계 | 방식 | FPS | 구현 난이도 |
|-----|------|-----|-----------|
| Phase 1 | MJPEG (xcrun simctl io screenshot 루프) | ~10fps | ⭐ |
| Phase 2 | WebRTC (AVFoundation 캡처) | ~60fps | ⭐⭐⭐⭐ |

**터치 인젝션 (WebDriverAgent)**
```
POST http://localhost:8100/session/{id}/actions
{ actions: [{ type:'pointer', actions:[
   { type:'pointerMove', x:100, y:200 },
   { type:'pointerDown' }, { type:'pointerUp' }
]}]}
```

> **WDA 실행 전제 조건 (Phase 1)**  
> Phase 1에서는 WDA가 이미 실행 중인 상태(`localhost:8100`)를 가정한다.  
> Phase 2에서 `npx tapflow ios setup` 커맨드로 설치·빌드·실행을 자동화한다.

### 4.3 AndroidAgent

**에뮬레이터 제어**
```bash
emulator -avd Pixel_8 -no-window -no-audio -gpu swiftshader_indirect
adb wait-for-device
adb install MyApp.apk
adb shell am start -n com.example.app/.MainActivity
```

**터치 인젝션**
```bash
adb shell input tap 100 200
adb shell input swipe 100 500 100 200 300
adb shell input text 'hello'
```

**화면 캡처**
```bash
adb exec-out screencap -p   # PNG 스트림
# 또는 scrcpy 기반 H.264 스트리밍
```

### 4.4 플랫폼 등록 구조

새 플랫폼 추가 시 AgentRegistry에 등록만 하면 된다. 릴레이/대시보드 코드 변경 없음.

```typescript
AgentRegistry.register('ios', IOSAgent)
AgentRegistry.register('android', AndroidAgent)
// 추후: AgentRegistry.register('web', BrowserAgent)
```

---

## 5. 릴레이 서버

### 5.1 NAT 통과 원리

Agent가 릴레이로 먼저 outbound WebSocket 연결을 맺고 대기한다. 방화벽/NAT 문제가 없다. QA팀 브라우저는 릴레이에만 접속하면 된다.

```
Agent → (outbound) → Relay ← (inbound) ← Browser
```

### 5.2 메시지 프로토콜

| 메시지 타입 | 방향 | 설명 |
|-----------|------|------|
| stream:frame | Agent → Browser | MJPEG 프레임 or H.264 청크 |
| input:tap | Browser → Agent | 터치 좌표 전달 |
| input:swipe | Browser → Agent | 스와이프 좌표·시간 |
| input:type | Browser → Agent | 텍스트 입력 |
| session:start | Browser → Relay | 세션 생성 요청 |
| session:end | Browser → Relay | 세션 종료 |
| app:upload | Browser/CLI → Relay | 앱 빌드 파일(.ipa/.apk) 업로드 |
| app:deliver | Relay → Agent | 파일 전달 + 로컬 저장 지시 |
| app:install | Browser → Relay → Agent | 특정 버전 시뮬레이터에 설치 |
| app:list | Browser → Relay | 등록된 버전 목록 요청 |

### 5.3 릴레이 서버 스펙

화면 데이터를 전달만 하므로 스펙이 낮아도 된다.

| 클라우드 | 인스턴스 | 예상 비용 |
|--------|--------|---------|
| AWS | t3.small | ~$15/월 |
| GCP | e2-small | ~$13/월 |
| fly.io | shared-cpu-1x | ~$5/월 |
| 자체 서버 | - | 무료 |

---

## 6. CLI (`npx tapflow`)

### 6.1 사용자 경험

Vercel CLI처럼 인프라 지식 없이 원클릭 배포. Pulumi는 내부에서만 사용하며 유저에게 노출되지 않는다.

```bash
# 1. 릴레이 서버 배포 (1회)
npx tapflow deploy
  > ? Cloud provider: (AWS / GCP / fly.io / self-hosted)
  > ✓ Relay server deployed: wss://relay.myteam.tapflow.dev

# 2. Agent 시작
npx tapflow agent start --relay wss://relay.myteam.tapflow.dev
  > ✓ iOS Agent connected (2 simulators available)
  > ✓ Android Agent connected (1 emulator available)

# 3. QA팀 초대
npx tapflow invite qa@company.com

# 4. iOS 환경 초기 세팅 (Mac Agent 머신에서 1회)
npx tapflow ios setup
  > Downloading WebDriverAgent...
  > ? Apple Team ID (found: AUG3P9AA8U): [enter]
  > Building WDA for simulator... (~2분)
  > ✓ WDA ready — localhost:8100 will auto-start with agent

# 5. 앱 빌드 업로드 (개발자 — CI/CD 또는 수동)
npx tapflow upload MyApp.ipa --name "v1.2.3-staging"
  > ✓ Uploaded to iOS Agent (12.3 MB)
  > ✓ Version registered: v1.2.3-staging

# 6. 상태 확인
npx tapflow status
```

### 6.2 내부 동작 (Pulumi 추상화)

```typescript
// 유저는 보지 않음 — CLI가 자동 처리
const server = new aws.ec2.Instance('tapflow-relay', {
  instanceType: 't3.small',
  userData: relayServerSetupScript,
})
const sg = new aws.ec2.SecurityGroup('tapflow-sg', {
  ingress: [{ port: 443, protocol: 'tcp' }]
})
```

---

## 7. Web Dashboard

### 7.1 주요 화면

| 화면 | 설명 |
|-----|------|
| 디바이스 목록 | 연결된 iOS/Android 디바이스 및 상태 표시 |
| 시뮬레이터 뷰어 | 실시간 스트림 + 터치 인터랙션 |
| 앱 버전 관리 | .ipa/.apk 업로드, 버전 목록, 디바이스에 설치 |
| 세션 녹화/재생 | QA 세션 녹화, 버그 재현용 재생 |
| 버그 리포트 | 스크린샷 + 메모 + 재현 스텝 자동 첨부 |
| 테스트 케이스 | 테스트 스텝 작성, 실행, 결과 기록 |
| 팀 관리 | 멤버 초대, 권한 설정 |

### 7.2 플랫폼 전환 UX

대시보드에서 iOS ↔ Android를 탭 하나로 전환. 내부적으로 AgentRegistry에서 해당 Agent를 조회한다.

```typescript
const agent = AgentRegistry.get(selectedPlatform) // 'ios' | 'android'
await agent.boot(selectedDeviceId)
```

---

## 8. 개발 로드맵

### Phase 1 — iOS MVP (4~6주)
목표: 브라우저에서 iOS 시뮬레이터 화면 보고 터치 가능

- DeviceAgent 인터페이스 정의
- IOSAgent: xcrun simctl 래퍼
- IOSAgent: MJPEG 스트리밍
- IOSAgent: WebDriverAgent 터치 연동
- 릴레이 서버: WebSocket 터널
- Web Dashboard: 시뮬레이터 뷰어 (기본)

### Phase 2 — 팀 사용성 (3~4주)
목표: QA팀이 실제로 쓸 수 있는 수준

- CLI: `npx tapflow deploy` (fly.io 먼저)
- CLI: `npx tapflow ios setup` — WDA 자동 설치·빌드·실행
  - `appium-webdriveragent` npm 패키지 다운로드
  - `xcodebuild`로 시뮬레이터용 빌드 (Team ID 1회 입력)
  - 이후 `agent start` 시 WDA 자동 시작
- JWT 인증 + 팀 초대 시스템
- 세션 녹화 + 재생
- 스크린샷 + 버그 리포트
- 앱 버전 관리: `npx tapflow upload` + Dashboard 업로드 UI
  - Relay: 버전 메타데이터(이름, 플랫폼, 업로드일) 관리
  - Agent: 파일 로컬 저장 + `app:install` 명령 처리
  - QA/Designer: Dashboard에서 버전 선택 → 시뮬레이터에 바로 설치

### Phase 3 — Android 지원 (3~4주)
목표: 동일 인터페이스로 Android 에뮬레이터 지원

- AndroidAgent: ADB 래퍼 구현
- Android 에뮬레이터 부팅/종료 자동화
- Web Dashboard: 플랫폼 전환 UI
- Linux Agent 지원 (클라우드 EC2 등)

### Phase 4 — 고도화 (지속)

- WebRTC 스트리밍 (MJPEG → H.264, ~60fps)
- 멀티 시뮬레이터 동시 세션
- Playwright 기반 자동화 테스트 연동
- CI/CD 연동 (GitHub Actions)
- `npx tapflow deploy` — AWS/GCP 추가

---

## 9. 기술 스택

| 영역 | 선택 | 이유 |
|-----|------|------|
| Agent (공통) | Node.js + TypeScript | xcrun/ADB 래핑, 팀 선호 스택 통일 |
| 릴레이 서버 | Node.js + ws | 경량, WebSocket 특화 |
| 인프라 배포 | Pulumi (TypeScript) | 멀티 클라우드, 코드로 관리 |
| Web Dashboard | Next.js + TypeScript | 팀 선호 스택 |
| 스트리밍 v1 | MJPEG | 빠른 구현, ~10fps |
| 스트리밍 v2 | WebRTC (H.264) | 저지연, ~60fps |
| iOS 터치 | WebDriverAgent | 오픈소스, Appium 검증 |
| Android 터치 | ADB shell input | 표준 도구, 별도 설치 불필요 |
| 인증 | JWT + 초대 링크 | 단순, 충분 |

---

## 10. 제약사항 및 한계

| 제약 | 내용 |
|-----|------|
| iOS macOS 필수 | Apple 정책상 iOS 시뮬레이터는 macOS에서만 실행 가능 |
| Mac 전원 유지 | QA팀 사용 중 iOS Agent Mac이 켜져 있어야 함 |
| 동시 세션 한계 | Mac 1대당 시뮬레이터 동시 2~4개 (RAM 기준) |
| 릴레이 비용 | 소프트웨어 무료, 릴레이 서버 인프라 비용 별도 (~$5~15/월) |
| Android GPU | 클라우드 Linux에서 소프트웨어 렌더링으로 성능 제한 |

---

## 11. 비즈니스 모델 (선택적)

오픈소스 셀프호스팅을 베이스로, GitLab 모델 적용 가능.

| 에디션 | 가격 | 내용 |
|-------|------|------|
| Community (OSS) | 무료 | 셀프호스팅, 모든 코어 기능 |
| Cloud | 유료 (월정액) | 관리형 릴레이, 팀 대시보드, 기술 지원 |

---

## 12. 성공 지표

| 지표 | 목표 |
|-----|------|
| GitHub Stars | 3개월 내 500+ |
| 실사용 팀 | 베타 10개 팀 이상 |
| MJPEG 레이턴시 | < 500ms |
| WebRTC 레이턴시 | < 150ms |
| 세션 안정성 | 99% (Mac/Linux Agent 기준) |
