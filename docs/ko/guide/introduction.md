# 소개

**tapflow**는 QA가 iOS 시뮬레이터와 Android 에뮬레이터를 브라우저에서 직접 실행할 수 있도록 해줍니다. Appetize, BrowserStack, 또는 외부 클라우드 없이 사용 가능합니다.

## 왜 tapflow인가요?

| 솔루션 | 문제점 |
|--------|--------|
| Appetize / BrowserStack | 비용이 비싸고, 앱 데이터가 외부 네트워크로 유출됨 |
| 실제 디바이스 | 구매 비용, 분실·파손 위험, 관리 오버헤드 |
| Xcode / Android Studio 직접 사용 | QA 각자 Mac + Xcode 또는 Android Studio 설정 필요 |
| tapflow | 이미 보유한 인프라 활용, 데이터 온-프레미스 유지 |

## 동작 원리

```mermaid
flowchart TD
    B["브라우저 (QA)"]
    R["릴레이 서버<br/>Linux 서버 또는 Mac"]
    A1["Mac 에이전트 1<br/>iOS · Android 시뮬레이터"]
    A2["Mac 에이전트 2<br/>iOS · Android 시뮬레이터"]
    More["Mac 에이전트 N<br/>iOS · Android 시뮬레이터"]

    B <-->|WebSocket| R
    R <-->|WebSocket outbound| A1
    R <-->|WebSocket outbound| A2
    R -.->|WebSocket outbound| More
```

1. **Mac 에이전트**가 릴레이에 아웃바운드로 연결합니다. 인바운드 방화벽 규칙이 필요 없습니다.
2. QA는 브라우저에서 대시보드를 열어 사용 가능한 디바이스를 확인합니다.
3. 터치 이벤트는 실시간으로 전달되고, 화면은 스트리밍으로 브라우저에 표시됩니다.

::: info 플랫폼별 스트리밍 방식
- **iOS** 시뮬레이터: JPEG 프레임 (~30fps) 스트리밍
- **Android** 에뮬레이터: H.264 스트리밍 (~30fps, scrcpy 기반)

두 방식의 화질·지연감이 다를 수 있습니다.
:::

## 핵심 개념

- **Relay** — 중앙 서버. 에이전트와 브라우저 사이의 트래픽을 라우팅합니다. 한 번만 배포하면 됩니다.
- **Agent** — Mac에서 실행됩니다 (iOS 및 Android). 릴레이에 연결합니다.
- **Dashboard** — 릴레이가 서빙하는 React SPA. 별도 배포가 필요 없습니다. App Center(빌드 관리), Mac Resources(에이전트 모니터링) 등의 페이지로 구성됩니다.
