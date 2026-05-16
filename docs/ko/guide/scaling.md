# Mac 리소스 확장

tapflow는 수평 확장이 가능합니다. 동일한 릴레이에 Mac 호스트를 추가하면 디바이스 풀이 늘어납니다. 각 Mac은 자체 에이전트를 실행하고 아웃바운드로 릴레이에 연결하므로 방화벽 규칙 변경이 필요 없습니다.

동작 원리는 [소개 — 동작 원리](/ko/guide/introduction#동작-원리)를 참고하세요.

## 두 번째 Mac 추가

새 Mac에 tapflow를 설치하고 기존 릴레이를 지정합니다:

```sh
npm install -g tapflow
tapflow agent start --relay wss://your-relay-url
```

이게 전부입니다. 새 Mac이 자동으로 등록되고, 해당 Mac의 디바이스가 즉시 대시보드에 표시됩니다.

## 에이전트 이름

각 에이전트는 Mac의 호스트명을 대시보드 표시 이름으로 사용합니다. 어떤 에이전트가 어떤 것인지 확인하려면:

```sh
tapflow status --relay wss://your-relay-url
```

```
  ● mac-mini-office
      ○  iPhone 16 Pro
      ○  iPhone 15

  ● mac-mini-lab
      ○  iPhone 14
      ○  Pixel 8
```

에이전트 이름은 Mac의 시스템 호스트명에서 가져옵니다 (macOS에서 `scutil --get ComputerName`). 변경하려면 **시스템 설정 → 일반 → 공유 → 컴퓨터 이름**에서 수정합니다.

## Mac당 시뮬레이터 수

iOS 시뮬레이터와 Android 에뮬레이터는 메모리를 많이 사용합니다. 동시에 실행 가능한 수는 Mac의 RAM과 CPU에 따라 다릅니다.

시뮬레이터는 대시보드를 통해 부팅·관리됩니다. 에이전트는 부팅된 시뮬레이터만 릴레이에 보고하므로 QA는 실제 사용 가능한 것만 볼 수 있습니다.

## 모니터링

대시보드 **Mac Resources** 탭에서 에이전트별 CPU·RAM 사용량을 확인합니다. 각 호스트가 시계열 차트(1h / 6h / 24h / 7d)로 표시됩니다.

빠른 CLI 확인:

```sh
tapflow status --relay wss://your-relay-url
```
