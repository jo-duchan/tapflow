# tapflow

**Product Requirements & Technical Design**  
버전 0.6 · 2026-05-15 · Draft

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
│              QA팀 (브라우저, 복수 동시 접속)             │
│    WebRTC/MJPEG 스트림 수신 + 터치 이벤트 전송           │
└──────────────────┬──────────────────────────────────────┘
                   │ WebSocket / WebRTC
┌──────────────────▼──────────────────────────────────────┐
│     릴레이 서버 (팀이 npx tapflow deploy로 배포)         │
│    NAT 통과 · 세션 라우팅 · 인증/초대 관리               │
└────┬───────────────────────────────────┬────────────────┘
     │ WebSocket (outbound)              │ WebSocket (outbound)
┌────▼────────────┐              ┌───────▼─────────────┐
│  Mac 1 Agent    │   ...        │  Mac N Agent        │
│  IOSAgent       │              │  IOSAgent           │
│  시뮬레이터 2~4 │              │  시뮬레이터 2~4     │
└─────────────────┘              └─────────────────────┘
```

**멀티 Mac 풀**: 여러 Mac이 동일한 relay에 연결하면 대시보드에서 모든 Mac의 시뮬레이터가 하나의 디바이스 목록으로 표시된다. QA팀원 각각이 서로 다른 Mac의 시뮬레이터를 동시에 독립적으로 사용할 수 있다. 추가 설정 없이 agent를 실행하고 같은 relay URL을 지정하면 자동으로 풀에 합류한다.

### 3.2 컴포넌트 역할

| 컴포넌트 | 역할 | 기술 스택 |
|---------|------|----------|
| DeviceAgent (iOS) | 시뮬레이터 제어, 화면 캡처, 터치 인젝션 | Node.js + xcrun simctl + IOHIDDigitizerDispatch (Swift) + WebDriverAgent |
| DeviceAgent (Android) | 에뮬레이터 제어, ADB 래핑 | Node.js + ADB |
| 릴레이 서버 | NAT 통과, 세션 라우팅, JWT 인증, 데이터 저장 | Node.js + ws + SQLite |
| Web Dashboard | QA팀 UI, 세션 뷰어, 테스트 관리 | Vite + React 19 + TypeScript |
| CLI (tapflow) | 릴레이 배포, Agent 설정, 팀 관리, 앱 배포 | Node.js CLI + Pulumi |

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
  launchApp(bundleId: string, deepLink?: string): Promise<void>  // Deep Link 지원
  screenshot(): Promise<Buffer>
  stream(): ReadableStream           // MJPEG or H.264
  touchStart(x: number, y: number): void
  touchMove(x: number, y: number): Promise<void>
  touchEnd(): Promise<void>
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
| Phase 1 ✅ | SimulatorKit IOSurface 콜백 + DispatchSourceTimer → JPEG + IOSurfaceGetSeed 정적 프레임 스킵 | 활성 ~30fps / 정적 ~10fps | ⭐⭐ |
| Phase 2 | WebRTC (AVFoundation 캡처) | ~60fps | ⭐⭐⭐⭐ |

**터치 인젝션 (IOHIDDigitizerDispatch)**

WDA W3C Actions API는 배치(batch) 요청 방식이라 연속 이벤트 스트리밍에 부적합하다 — 이벤트마다 독립적인 HTTP 왕복이 필요해 연속 탭이나 스와이프가 직렬화되어 느려진다.

대신 SimulatorKit 비공개 API인 `IOHIDDigitizerDispatch`를 사용한다. HID 이벤트를 직접 시뮬레이터 프로세스에 주입하므로 응답 대기 없이 스트리밍이 가능하다.

`touch-helper` Swift 바이너리가 CoreSimulator·SimulatorKit을 dlopen으로 로드하고, stdin에서 9바이트 프레임을 읽어 즉시 HID 이벤트로 변환·주입한다.

```
stdin 프로토콜: [type:uint8][x:float32BE][y:float32BE]  (9바이트/이벤트)
  type 1 = touch start, 2 = touch move, 3 = touch end
  x, y = 디바이스 논리 포인트 좌표 (WDA getWindowSize 기준)
```

물리 버튼(볼륨·전원·홈) 인젝션과 키보드 입력은 WDA를 그대로 사용한다.

```
POST http://localhost:8100/session/{id}/wda/pressButton  ← 물리 버튼 (WDA 유지)
POST http://localhost:8100/session/{id}/actions          ← 키보드 입력 (WDA 유지)
```

> **WDA 실행 전제 조건**  
> WDA는 물리 버튼·키보드 입력을 위해 여전히 필요하다 (`localhost:8100`).  
> `npx tapflow ios setup` 커맨드로 설치·빌드·실행을 자동화한다.

**Android 터치 인젝션 ✅ Phase 3 완료**

```bash
adb shell input tap 100 200       # 탭
adb shell input swipe 100 500 100 200 300  # 스와이프
adb shell input text 'hello'
```

### 4.3 AndroidAgent ✅ Phase 3 완료

**에뮬레이터 제어**
```bash
emulator -avd Pixel_8 -no-window -no-audio -gpu swiftshader_indirect
adb wait-for-device
adb install MyApp.apk
adb shell am start -n com.example.app/.MainActivity
```

**터치 인젝션** — `AndroidTouchHelper` via `adb shell input`

**화면 스트리밍** — scrcpy H.264

scrcpy 서버(`scrcpy-server.jar`)를 기기에 push·실행 후 TCP 소켓으로 H.264 Annex B 스트림을 수신한다. 대시보드에서 WebGL(`WebGLVideoRenderer` + `H264Decoder`)로 디코딩·렌더링.

| 구성 | 내용 |
|------|------|
| 인코더 | `OMX.google.h264.encoder` (순수 소프트웨어 고정 — `c2.android.avc.encoder`는 GPU 앱 실행 시 stall) |
| 정적 프레임 | `KEY_REPEAT_PREVIOUS_FRAME_AFTER=100ms` — 정적 화면에서 ~10fps keep-alive (iOS와 동일 동작) |
| 회전 감지 | `ROTATION_NOTIFICATION` (control 소켓 type=4) → `device:rotate` 메시지로 뷰어 CSS 회전 동기화 |
| AVD 이미지 | `google_apis/arm64-v8a` (android-34) 필수 — `google_apis_playstore`는 H.264 인코더 crash |

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

**WebSocket 제어 메시지** (JSON)

| 메시지 타입 | 방향 | 설명 |
|-----------|------|------|
| `agent:register` | Agent → Relay | Agent 등록 (agentName, devices[]) |
| `agent:registered` | Relay → Agent | 등록 확인 (sessionId 포함) |
| `agents:list` | Browser → Relay | 연결된 Agent 목록 요청 |
| `agents:listed` | Relay → Browser | Agent·디바이스 목록 응답 |
| `session:start` | Browser → Relay | 세션 참가 요청 (sessionId, deviceId) |
| `session:joined` | Relay → Browser | 참가 확인 |
| `session:chrome` | Agent → Relay → Browser | 디바이스 프레임 PNG + screenRect + 버튼 레이아웃 |
| `session:deviceInfo` | Agent → Relay → Browser | 기기명 + iOS 버전 |
| `session:end` | Browser → Relay | 세션 종료 |
| `device:boot` | Browser → Relay → Agent | 시뮬레이터 부팅 요청 (deviceId) |
| `device:booting` | Agent → Relay → Browser | 부팅 시작 알림 |
| `device:ready` | Agent → Relay → Browser | 부팅 완료 (deviceId) |
| `device:boot-error` | Agent → Relay → Browser | 부팅 실패 (message) |
| `device:shutdown` | Browser → Relay → Agent | 시뮬레이터 종료 요청 (deviceId) |
| `device:shutdown-done` | Agent → Relay → Browser | 종료 완료 (deviceId) |
| `app:install` | Browser → Relay → Agent | 빌드 설치 요청 (buildId). Relay가 DB에서 file_path 조회 후 Agent에 전달 |
| `app:install-done` | Agent → Relay → Browser | 설치 완료 |
| `app:install-error` | Agent → Relay → Browser | 설치 실패 (message) |
| `app:launch` | Browser → Relay → Agent | 앱 실행 요청 (buildId). Relay가 DB에서 bundle_id 조회 후 Agent에 전달 |
| `app:launch-done` | Agent → Relay → Browser | 앱 실행 완료 |
| `app:launch-error` | Agent → Relay → Browser | 앱 실행 실패 (message) |
| `input:touch:start` | Browser → Relay → Agent | 터치 시작 (정규화 좌표 0~1) |
| `input:touch:move` | Browser → Relay → Agent | 터치 이동 (정규화 좌표 0~1, 16ms throttle) |
| `input:touch:end` | Browser → Relay → Agent | 터치 종료 |
| `input:pinch:start` | Browser → Relay → Agent | 핀치 시작 (f0, f1 정규화 좌표) |
| `input:pinch:move` | Browser → Relay → Agent | 핀치 이동 |
| `input:pinch:end` | Browser → Relay → Agent | 핀치 종료 |
| `input:button` | Browser → Relay → Agent | 물리 버튼 (볼륨·전원·홈 등) |
| `input:rotate` | Browser → Relay → Agent | 화면 회전 (portrait ↔ landscapeRight) |
| `input:type` | Browser → Relay → Agent | 텍스트 입력 |
| `error` | Relay → Browser | 오류 메시지 |

**Binary 프레임** (WebSocket binary)

Agent가 JPEG 프레임을 바이너리로 직접 전송한다. Relay는 내용을 파싱하지 않고 즉시 포워딩한다.

**코멘트 API** (HTTP REST — WebSocket 아님)

코멘트 CRUD는 `GET/POST/DELETE /api/v1/comments` HTTP 엔드포인트를 사용한다. WebSocket broadcast는 Phase 3 이후 예정이다.

### 5.3 데이터 저장 (SQLite)

릴레이 서버에 SQLite를 내장한다. 팀이 relay를 소유하므로 모든 데이터의 소유권도 팀에 귀속된다. 외부 DB 서버 불필요, 백업은 파일 복사 한 번으로 충분.

```
relay 서버 디스크
  ├── tapflow.config.json  ← 서버 설정 (port, jwtSecret, SMTP 등)
  ├── tapflow.db           ← SQLite (메타데이터)
  └── uploads/
      ├── builds/          ← .app.zip (iOS) · .apk (Android) 바이너리
      ├── avatars/         ← 유저 프로필 아바타 (png · jpg)
      ├── comments/        ← 코멘트 첨부 이미지 (png · jpg · webp)
      └── team/            ← 팀 로고
```

| 테이블 | Phase | 내용 |
|--------|-------|------|
| `apps` | 3 | 앱 엔티티 (name, bundle_id_key, platform, created_at) — bundle_id_key로 업로드 시 자동 생성·조회 |
| `builds` | 3 | 빌드 산출물 (**app_id** FK, **version_name**, **build_number**, bundle_id, status_label, file_path, uploader_id, uploaded_at) |
| `users` | 2 | 팀 멤버 (email, password_hash, **display_name**, **avatar_url**, role, joined_at) |
| `invitations` | 2 | 초대 링크 (token, email, role, expires_at, used_at) |
| `password_reset_tokens` | 3 | 비밀번호 재설정 토큰 (user_id FK, token UNIQUE, expires_at, used_at) — 2시간 유효 |
| `comments` | 2 | 빌드별 QA 코멘트 (build_id, author_id, body, parent_id, created_at) |
| `comment_attachments` | 2 | 코멘트 첨부 이미지 (comment_id, file_path, mime, size) |
| `personal_access_tokens` | 2 | API 배포용 PAT (user_id, name, token_hash, scope, expires_at) |
| `team_settings` | 2 | 팀 설정 singleton (team_name, logo_path) |
| `sessions` | 2 | 세션 녹화 기록 (deviceId, startedAt, duration, recordingPath) |
| `bug_reports` | 2 | 스크린샷 경로 + 메모 + 재현 스텝 |
| `test_cases` | 2 | 테스트 스텝 + 실행 결과 |

> **apps / builds 분리 배경**: Phase 2까지는 `apps` 테이블이 Build 역할을 겸했다. Phase 3 진입 전 구조 정비에서 도메인을 올바르게 분리한다. 한 팀이 여러 앱을 운영하고, 한 버전에서 여러 빌드가 누적되는 실무 패턴을 수용하기 위함이다.

> **닉네임·아바타**: `users.display_name` 기본값은 `email @ 앞` 자동 적용. `avatar_url` 미설정 시 UI에서 이름 첫 글자 + 해시 색상으로 폴백. 코멘트·빌드 업로더·사이드바 전체에 통일 반영.

### 5.4 설정 파일 (`tapflow.config.json`)

릴레이 서버를 실행하는 디렉토리 루트에 `tapflow.config.json`을 두면 자동으로 읽는다. 파일이 없으면 기본값으로 동작한다.

```json
{
  "server": {
    "port": 4000,
    "dataDir": ".tapflow",
    "jwtSecret": "CHANGE_THIS_TO_A_LONG_RANDOM_SECRET"
  },
  "smtp": {
    "host": "",
    "port": 587,
    "secure": false,
    "user": "",
    "pass": "",
    "from": "tapflow <noreply@example.com>"
  }
}
```

**우선순위**: `tapflow.config.json` → 환경변수(Docker/CI 오버라이드) → 기본값

환경변수(`TAPFLOW_PORT`, `JWT_SECRET`, `SMTP_HOST` 등)는 config 파일보다 항상 우선 적용되므로 컨테이너 배포 시에도 그대로 사용할 수 있다. 레포에 `tapflow.config.example.json`이 포함되어 있다.

### 5.5 릴레이 서버 스펙

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

# 4. 환경 진단 (문제 발생 시)
npx tapflow doctor
  > ✓ Node.js 24.x
  > ✓ Xcode 26.4.1
  > ✗ iOS Simulator Runtime
  >     Xcode SDK: iOS 26.4  |  설치된 런타임: iOS 18.5 (불일치)
  >     → npx tapflow ios setup --fix 으로 자동 수정
  > ✗ WebDriverAgent
  >     localhost:8100 응답 없음
  >     → npx tapflow ios setup 으로 WDA 설치

# 5. iOS 환경 초기 세팅 (Mac Agent 머신에서 1회)
npx tapflow ios setup
  > Detecting Xcode SDK... iOS 26.4
  > Checking simulator runtimes... iOS 18.5 (mismatch)
  > Downloading iOS 26.4 Simulator Runtime... (~3GB)
  > Downloading WebDriverAgent...
  > ? Apple Team ID (found: AUG3P9AA8U): [enter]
  > Building WDA for simulator... (~2분)
  > ✓ WDA ready — localhost:8100 will auto-start with agent

# 6. 앱 빌드 업로드 (개발자 — CI/CD 또는 수동)
# iOS: xcodebuild -sdk iphonesimulator로 빌드한 .app 디렉토리를 zip 압축
npx tapflow upload MyApp.app.zip --status "In Progress" --token <pat>
  > ✓ App: Coffee App (com.example.coffee · ios) — created
  > ✓ Build registered: v1.2.3 (build 89) [In Progress]

# Android
npx tapflow upload MyApp.apk --status "In Progress" --token <pat>
  > ✓ App: Coffee App (com.example.coffee · android) — created
  > ✓ Build registered: v1.2.3 (build 89) [In Progress]

# 7. 상태 확인
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

### 6.3 API 엔드포인트 (PAT 인증)

CI/CD 파이프라인이 `Authorization: Bearer <pat>` 헤더로 빌드를 업로드한다.

```
POST /api/v1/builds
Content-Type: multipart/form-data
Authorization: Bearer tflw_pat_<token>

Fields:
  file      required  .app.zip (iOS 시뮬레이터 빌드) 또는 .apk (Android) (최대 500MB)
  status    optional  Backlog | In Progress | Done | Rejected
  platform  optional  ios | android (파일 확장자로 자동 감지)

Response:
  201  { id, app_id, version_name, build_number, bundle_id, status_label, platform, uploaded_at }
  400  Bad Request (파일 없음, 형식 오류, 시뮬레이터 슬라이스 없음)
  401  Unauthorized (PAT 누락 또는 만료)
  403  Forbidden (scope 불일치)

GET /api/v1/apps
Authorization: Bearer <jwt> 또는 tflw_pat_<token>

Response:
  200  { items: [{ id, name, bundle_id_key, platform, latest_build: { version_name, build_number, status_label, uploaded_at } }] }
```

> **bundle_id 자동 추출**: `.app.zip` 업로드 시 Relay가 zip 안의 `*.app/Info.plist`에서 `CFBundleIdentifier`(bundle_id), `CFBundleShortVersionString`(version_name), `CFBundleVersion`(build_number)을 추출해 DB에 저장한다. 추출 실패 시 `null`로 저장되며, `app:launch` 요청 시 오류를 반환한다.

> **App 자동 생성**: 업로드 시 `bundle_id_key`(`CFBundleIdentifier`)로 `apps` 테이블을 조회해 없으면 자동 생성한다. 같은 bundle_id의 빌드는 자동으로 같은 App에 귀속된다.

> **iOS 시뮬레이터 슬라이스 검증**: `.app.zip` 업로드 시 `lipo -info`로 x86_64 또는 arm64-simulator 슬라이스 존재를 확인한다. 디바이스용 슬라이스만 있으면 400을 반환하고, 응답 본문에 재빌드 안내를 포함한다.

**PAT 형식**: `tflw_pat_<random-64>`. SHA-256 hash만 DB에 저장. 발급 시 평문 1회 노출.  
**scope**: `builds:write` — 현 단계에서 API 배포에 필요한 유일한 scope.

---

## 7. Web Dashboard

### 7.1 주요 화면

| 화면 | 경로 | 설명 |
|-----|------|------|
| Login | `/login` | email/password 로그인 |
| Invite | `/invite?token=` | 초대 토큰 검증 → 닉네임·아바타 설정 → 비밀번호 설정 → 가입 |
| Reset Password | `/reset-password?token=` | 비밀번호 재설정 토큰 검증 → 새 비밀번호 설정 |
| App Center | `/app-center` | App 목록 사이드바(bundle_id 기반) · Release Accordion(version_name 그룹) · Build 카드 + Start QA CTA, 수동/API 업로드, 상태 태그, 검색·필터 |
| QA Session | `/app-center/build?id=` | Device 선택 → 부팅 → `.app.zip` 자동 설치(기존 버전 uninstall 후 재설치), 시뮬레이터 뷰어 + 터치, 코멘트(이미지 첨부·deep-link 공유) |
| Settings > Default | `/settings/default` | **전체 역할 접근 가능** — Workspace(팀 이름·로고, Admin 전용) · Profile(닉네임·아바타, 전체) · Password(비밀번호 변경, 전체) · Apps(앱 이름 편집, Admin/Developer) |
| Settings > Team | `/settings/team` | 멤버 초대(email+role, 초대 이메일 자동 발송)·권한 변경·삭제·비밀번호 리셋 메일 발송 (Admin 전용) |
| Settings > Tokens | `/settings/tokens` | PAT 발급·철회 (Admin 전용) |
| 이벤트 로그 | — | Backlog |
| 세션 녹화/재생 | — | Phase 3 예정 |

### 7.2 역할별 대시보드 뷰

역할에 따라 접근 권한이 달라진다.

| 역할 | 접근 가능 화면 | 빌드 상태 변경 | 코멘트 작성 | 수동 업로드 | PAT 발급 | 팀 설정 |
|-----|--------------|-------------|-----------|------------|---------|---------|
| Admin | 전체 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Developer | App Center, QA Session | ✅ | ✅ | ✅ | ❌ | ❌ |
| QA | App Center, QA Session | ✅ | ✅ | ✅ | ❌ | ❌ |
| Viewer | App Center (읽기), QA Session (읽기) | ❌ | ❌ | ❌ | ❌ | ❌ |

> `/settings/default`(Profile · Password)는 전체 역할이 접근 가능하다. `/settings/team` · `/settings/tokens`는 Admin 전용이며, 비Admin이 직접 URL로 진입하면 "Access Denied" 화면을 표시한다. 사이드바에서도 Admin이 아닌 유저에게 Team · Tokens 메뉴가 숨겨진다.

### 7.3 플랫폼 전환 UX

대시보드에서 iOS ↔ Android를 탭 하나로 전환. 내부적으로 AgentRegistry에서 해당 Agent를 조회한다.

```typescript
const agent = AgentRegistry.get(selectedPlatform) // 'ios' | 'android'
await agent.boot(selectedDeviceId)
```

---

## 8. 개발 로드맵

### Phase 1 — iOS MVP ✅ 완료
목표: 브라우저에서 iOS 시뮬레이터 화면 보고 터치 가능

- DeviceAgent 인터페이스 정의
- IOSAgent: xcrun simctl 래퍼
- IOSAgent: MJPEG 스트리밍
- IOSAgent: WebDriverAgent 터치 연동
- 릴레이 서버: WebSocket 터널
- Web Dashboard: 시뮬레이터 뷰어 (기본)

### Phase 2 — 팀 사용성 ✅ 완료
목표: QA팀이 실제로 쓸 수 있는 수준

**멀티 Mac 풀 기초**
- `agent:register` 시 `agentName` (os.hostname) 포함 → relay가 session에 저장
- 대시보드 디바이스 목록에 Mac 이름 표시 ("Mac Mini 사무실 · iPhone 16 Pro")
- 세션 점유 상태 표시 — 이미 다른 QA가 보고 있는 세션은 "사용 중" 표시 (browser 연결 여부로 판단)

- **SQLite 도입**: relay 서버에 `tapflow.db` 내장 — 이후 모든 데이터(앱, 세션, 유저, 버그)의 기반
- CLI: `npx tapflow deploy` (fly.io 먼저)
- CLI: `npx tapflow doctor` — 환경 진단 및 수정 가이드
  - Xcode 버전 확인
  - iOS Simulator Runtime 버전과 Xcode SDK 버전 일치 여부 검사
  - WDA 실행 상태 확인 (`localhost:8100`)
  - Node.js 버전 확인
  - 문제 항목마다 수정 커맨드 안내
- CLI: `npx tapflow ios setup` — WDA 자동 설치·빌드·실행
  - Xcode SDK 버전 자동 감지 (`xcodebuild -showsdks`)
  - 일치하는 iOS Simulator Runtime 없으면 자동 다운로드 (`xcodebuild -downloadPlatform iOS`)
  - `appium-webdriveragent` npm 패키지 다운로드
  - `xcodebuild`로 시뮬레이터용 빌드 (Team ID 1회 입력)
  - 이후 `agent start` 시 WDA 자동 시작
- JWT 인증 + 팀 초대 시스템 + 역할별 권한 (Admin / Developer / QA / Viewer)
- 세션 녹화 + 재생
- 스크린샷 + 버그 리포트
- **App Center**: `npx tapflow upload` + Dashboard App Center UI
  - CLI: `npx tapflow upload MyApp.ipa --label "v1.2.3-staging"` → relay 업로드 + SQLite 등록
  - Relay: SQLite `apps` 테이블에 메타데이터 저장, 바이너리는 `uploads/apps/`에 보관
  - Agent: relay에서 바이너리 수신 후 `xcrun simctl install` / `adb install` 처리
  - Dashboard: 버전 목록 → 디바이스 선택 → 원클릭 설치
  - CI/CD 연동: Jira Automation, GitHub Actions에서 `npx tapflow upload` 호출
- **Deep Link 실행**: Dashboard 뷰어 내 패널에서 URL Scheme 직접 트리거
  - `DeviceAgent.launchApp(bundleId, deepLink)` — iOS: `xcrun simctl openurl`, Android: `adb shell am start`
- **이벤트 로그 (기초)**: [Backlog] 앱 로그 스트림 → Dashboard 실시간 표시
  - iOS: `xcrun simctl spawn booted log stream`
  - Android: `adb logcat`

### Phase 3 — Android 지원
목표: 동일 인터페이스로 Android 에뮬레이터 지원

**구조 정비 ✅ 완료** (PR #14)

- **iOS 빌드 포맷**: `.ipa` → `.app.zip` (시뮬레이터 표준 포맷)
  - `lipo -info`로 시뮬레이터 슬라이스 검증, Linux relay에서는 skip
- **DB 재설계**: `apps` + `builds` 분리 (migration 004)
  - `version_name`/`build_number` 업로드 시 자동 추출
- **App Center UI 재설계**: App 사이드바 + Release Accordion + Build 카드 + Start QA CTA
- **QA Session 개선**: 매 세션 `simctl uninstall` 후 재설치로 클린 상태 보장
- **팀 협업 기반**: 닉네임 기본값(email @ 앞), UserAvatar 컴포넌트, 코멘트·빌드 아바타 반영
- **이메일 인증 플로우**: 초대 이메일 자동 발송, Invite 페이지 닉네임·아바타 설정, 비밀번호 변경, Admin 리셋 메일, `/reset-password` 페이지
- **Settings 권한 정비**: `/settings/default` 전체 허용, team·tokens Admin 전용
- **설정 파일**: `tapflow.config.json` (실행 디렉토리 루트), env var 오버라이드 지원

**Android ✅ 완료** (PR #17)

- AndroidAgent: ADB 래퍼 (`AdbWrapper`) + 에뮬레이터 부팅/종료 자동화 (`EmulatorLauncher`)
- scrcpy H.264 스트리밍 (`ScrcpySession` · `ScrcpyVideo` · `ScrcpyControl`)
- `ROTATION_NOTIFICATION` 기반 회전 자동 감지 + 뷰어 CSS 회전 동기화
- Web Dashboard: `SimulatorViewer` → `DeviceViewer` 분리 (iOS = `IOSViewer`, Android = `AndroidViewer`)
  - Android: WebGL H.264 렌더러 (`WebGLVideoRenderer` + `H264Decoder`)
- NOTICE: scrcpy Apache-2.0 저작권 고지 추가

**스트리밍 최적화 ✅ 완료** (PR #18 진행 중)

- iOS `IOSurfaceGetSeed()` 기반 정적 프레임 스킵 — Android `KEY_REPEAT_PREVIOUS_FRAME_AFTER`와 동일한 100ms keep-alive 방식
- FPS 인디케이터 Active/Idle 개념으로 전환 — 의도된 저FPS가 오류처럼 보이던 UX 문제 해결
- `npm run dev`에 android-agent 포함

**Phase 3 Won't Fix**

- Linux Agent 지원 (클라우드 EC2 등) — 보류
- WebRTC DataChannel 터치 — 보류

### Phase 4 — 고도화 (지속)

#### 4-A. Mac 풀 & 자원 관리 (핵심)

여러 대의 Mac을 RAID처럼 묶어 단일 디바이스 풀로 운영한다. QA팀은 어느 Mac의 시뮬레이터인지 신경 쓰지 않고 사용하고, 시스템이 자원 상황에 맞게 배분한다.

**디바이스 분배 정책**

| 정책 | 설명 |
|------|------|
| 라운드로빈 | 기본값 — Mac 간 세션을 순서대로 분배 |
| 자원 우선 | CPU·RAM 여유가 가장 많은 Mac에 먼저 배분 |
| 친화성 | 특정 OS 버전·기기 모델이 있는 Mac에 직접 배분 |

**Mac 자원 모니터링**

Agent가 주기적으로 CPU·RAM 사용률을 relay에 보고한다. 대시보드 디바이스 풀 뷰에서:
- Mac별 CPU·RAM 사용률 표시 (실시간)
- 가용 시뮬레이터 슬롯 수 (경험상 Mac 1대당 시뮬레이터 3대가 한계)
- 현재 점유자 — 누가 어떤 기기를 사용 중인지
- 자원 사용량 그래프 (시계열, 옵션)
- 대기열 — 모든 슬롯이 점유 중일 때 대기 순번 표시

**세션 시작 옵션 — 디바이스 초기화 모드**

- `앱 데이터만 초기화` (기본값): 해당 앱만 `simctl uninstall` 후 재설치
- `전체 초기화`: `simctl erase` 후 부팅 — 기본 앱 포함 전체 리셋, 부팅 시간 증가(~30s)

#### 4-B. 오픈소스 DX & 출시 준비

tapflow를 오픈소스 라이브러리로 다듬는 작업. 사용자가 처음 설치부터 운영까지 마찰 없이 경험하도록 한다. **Phase 4 완료 = 오픈소스 공개 시점.**

- **VitePress 문서 사이트**: 설치 가이드, 아키텍처 설명, API 레퍼런스, 기여 가이드
- **패키지 정리**: npm 배포, 버전 관리, changelog 자동화
- **배포 번들**: `npm run build`로 relay + dashboard를 단일 배포 가능한 아티팩트로 패키징 — 사용자가 직접 서버에 올릴 수 있는 수준
- **CLI 완성도**: `tapflow status`, `tapflow logs` 등 운영 편의 커맨드
- **에러 메시지 개선**: 설정 누락·버전 불일치 등 흔한 실패 시나리오에 명확한 안내

#### 4-C. 기타

- 멀티 시뮬레이터 동시 세션 (한 화면에서 여러 기기 동시 조작)
- Playwright 기반 자동화 테스트 연동
- CI/CD 연동 (GitHub Actions)

### Phase 5 — 인프라 배포 자동화

목표: 오픈소스 공개 이후 실제 사용자 피드백 기반으로 배포 마찰을 제거한다.

- `npx tapflow deploy` — fly.io(기본) · AWS · GCP 원클릭 배포
- Pulumi 기반 인프라 코드 (유저에게 노출 안 됨, CLI 내부 동작)
- Docker 이미지 제공 (relay 셀프호스팅 간소화)
- 업그레이드 자동화 (`tapflow update`)

---

## 9. 기술 스택

| 영역 | 선택 | 이유 |
|-----|------|------|
| Agent (공통) | Node.js + TypeScript | xcrun/ADB 래핑, 팀 선호 스택 통일 |
| 릴레이 서버 | Node.js + ws | 경량, WebSocket 특화 |
| DB | SQLite (better-sqlite3) | 외부 DB 서버 불필요, 셀프호스팅 친화적, 팀이 데이터 소유 |
| 인프라 배포 | Pulumi (TypeScript) | 멀티 클라우드, 코드로 관리 |
| Web Dashboard | Vite + React 19 + TypeScript + React Router v7 + Shadcn/ui + Tailwind CSS + next-themes | relay가 직접 서빙하는 SPA, 라이트/다크 테마 |
| 스트리밍 v1 | SimulatorKit IOSurface → JPEG | Private API, geometry 불필요, ~30fps |
| 스트리밍 v2 | WebRTC (H.264) | 저지연, ~60fps |
| iOS 터치 | IOHIDDigitizerDispatch (SimulatorKit, Swift) | 저지연 HID 스트리밍; WDA는 물리 버튼·키보드에만 유지 |
| Android 터치 | ADB shell input | 표준 도구, 별도 설치 불필요 (Phase 3) |
| 인증 | 자체 JWT + 초대 링크 + PAT (API 배포용) | 외부 의존 없음, 셀프호스팅 친화적 |

---

## 10. 제약사항 및 한계

| 제약 | 내용 |
|-----|------|
| iOS macOS 필수 | Apple 정책상 iOS 시뮬레이터는 macOS에서만 실행 가능 — Linux Agent는 지원하지 않음 |
| Mac 전원 유지 | QA팀 사용 중 iOS Agent Mac이 켜져 있어야 함 |
| 동시 세션 한계 | Mac 1대당 시뮬레이터 동시 2~4개 (RAM 기준) |
| 릴레이 비용 | 소프트웨어 무료, 릴레이 서버 인프라 비용 별도 (~$5~15/월) |
| Android GPU | 클라우드 Linux에서 소프트웨어 렌더링으로 성능 제한 |

### 10.1 네트워크 레이턴시

터치 입력은 WebSocket을 통해 전달되므로 relay↔agent 간 RTT가 체감에 직접 영향을 미친다.

| 환경 | 예상 RTT | 터치 체감 |
|-----|---------|----------|
| 사무실 LAN (relay = agent와 동일 Mac 또는 동일 네트워크) | < 5ms | 즉각 반응, 실사용 문제 없음 |
| VPN / 사내 WAN | 30~80ms | 드래그가 느리게 따라오는 느낌 |
| 원격 (국가 간 등) | 100ms+ | 정밀 드래그 조작 어려움 |

**운영 권장사항**: relay를 agent와 동일한 Mac 또는 동일 LAN에 배포하면 relay↔agent 구간이 loopback이 되어 네트워크 RTT는 브라우저↔relay 한 구간만 남는다. relay를 원격 서버에 올릴 경우 두 구간(브라우저→relay, relay→agent)이 중첩되어 체감 레이턴시가 늘어난다.

**Phase 3 예정**: WebRTC DataChannel로 touch 이벤트를 전송하면 UDP 기반으로 헤드오브라인 블로킹이 없고 오래된 move 이벤트를 자동으로 드랍할 수 있어 WAN 환경에서도 체감 레이턴시가 크게 개선된다.

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
