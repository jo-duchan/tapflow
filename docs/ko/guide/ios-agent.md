# iOS 에이전트 설정

iOS 에이전트는 Mac에서 실행되며 시뮬레이터 화면을 릴레이로 스트리밍합니다.

## 사전 요구사항

- macOS
- iOS Simulator Runtime이 설치된 Xcode
- Node.js ≥ 20

## 에이전트 시작

```sh
tapflow agent start --relay wss://your-relay-url
```

에이전트는 아웃바운드로 연결합니다. 인바운드 방화벽 규칙이 필요 없습니다.

### 옵션

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--relay` | `ws://localhost:4000` | 릴레이 WebSocket URL |
| `--device` | 부팅된 첫 번째 시뮬레이터 | 사용할 시뮬레이터 이름 또는 UDID |
| `--platform` | 자동 감지 | `ios` \| `android` \| `all` |

## 사용 가능한 시뮬레이터 확인

```sh
tapflow devices
```

## 특정 시뮬레이터 부팅

```sh
tapflow boot "iPhone 16 Pro"
```

## 여러 시뮬레이터 동시 사용

한 Mac에서 RAM에 따라 2–4개의 시뮬레이터를 동시에 실행할 수 있습니다. 에이전트가 사용 가능한 슬롯 수를 자동으로 보고합니다. 더 많은 시뮬레이터가 필요하다면 [Mac 리소스 확장](/ko/guide/scaling)을 참고하세요.

## 트러블슈팅

`tapflow doctor`를 실행해 일반적인 문제를 진단합니다:

```
Common
  ✓ Node v20.x

iOS
  ✓ Xcode 16.2
  ✓ xcrun simctl
  ✓ Simulator booted: iPhone 16 Pro
```

더 자세한 문제 해결 방법은 [문제 해결](/ko/guide/troubleshooting)을 참고하세요.
