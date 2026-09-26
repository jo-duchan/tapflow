# Mac 리소스 확장

tapflow는 수평 확장이 가능합니다. 동일한 릴레이에 Mac 호스트를 추가하면 기기 풀이 늘어납니다. 각 Mac은 자체 에이전트를 실행하고 아웃바운드로 릴레이에 연결하므로 방화벽 규칙 변경이 필요 없습니다.

::: warning 에이전트 Mac은 모두 릴레이와 같은 LAN에 있어야 합니다
추가하는 Mac도 릴레이로 영상 프레임을 지속적으로 전송하므로 릴레이와 같은 LAN에 있어야 합니다. 네트워크 요구사항은 [배포 네트워크](/ko/operate/deployment#배포-시나리오)를 참고하세요.
:::

동작 원리는 [소개 — 동작 원리](/ko/get-started/introduction#동작-원리)를 참고하세요.

## Mac 추가

::: tip 릴레이는 모든 Mac에서 접근 가능한 주소여야 합니다
다른 Mac에서 `tapflow agent start`를 실행할 때 `ws://localhost:4000`은 릴레이가 있는 Mac이 아니라 해당 Mac 자신의 localhost를 가리킵니다. 릴레이의 로컬 IP 주소(`ws://192.168.x.x:4000`)를 사용하세요.
:::

새 Mac에 tapflow를 설치하고 기존 릴레이를 지정합니다. 릴레이가 다른 머신에 있으므로 `agent` 스코프 토큰이 필요합니다([원격 릴레이 인증](/ko/operate/agents#원격-릴레이-인증)):

```sh
npm install -g tapflow
tapflow agent start --relay ws://192.168.x.x:4000 --token tflw_pat_xxxxxxxx
```

이게 전부입니다. 새 Mac이 자동으로 등록되고, 해당 Mac의 기기가 즉시 대시보드에 표시됩니다.

## 에이전트 이름

각 에이전트는 Mac의 호스트명을 대시보드 표시 이름으로 사용합니다. 어떤 에이전트가 어떤 것인지 확인하려면:

```sh
tapflow status
```

```
  ● agent  ◉ in use  ○ idle

  ● mac-mini-office.local  (iOS)
      ○  iPhone 16 Pro
      ○  iPhone 15

  ● mac-mini-lab.local  (iOS)
      ○  iPhone 14

  ● mac-mini-lab.local  (Android)
      ○  tapflow-phone

  3 agent(s) · 4 device(s) · 0 active session(s)
```

에이전트 이름은 Node의 `os.hostname()` 값이며 macOS에서는 보통 `.local`이 붙은 로컬 호스트 이름입니다. 한 Mac에서 iOS와 Android 에이전트가 함께 돌면 같은 이름으로 두 줄이 나오고 이름 뒤의 `(iOS)`·`(Android)`로 구분합니다. 변경하려면 **시스템 설정 → 일반 → 공유**의 **로컬 호스트 이름**을 수정합니다.

## Mac당 기기 수 {#mac당-디바이스-수}

iOS 시뮬레이터와 Android 에뮬레이터는 메모리를 많이 사용합니다. 일반적으로 Mac 한 대에서 RAM에 따라 2–4개를 동시에 실행할 수 있습니다.

시뮬레이터·에뮬레이터는 대시보드를 통해 부팅·관리됩니다. 에이전트는 부팅 여부와 관계없이 사용 가능한 기기를 모두 릴레이에 보고하고 팀원이 세션을 시작하면 필요한 기기를 부팅합니다.

## 모니터링

대시보드 **Mac Resources** 탭에서 에이전트별 CPU·RAM 사용량을 확인합니다. 호스트를 고르면 CPU와 RAM이 각각 시계열 차트(1h / 6h / 24h / 7d)로 표시됩니다.

빠른 CLI 확인:

```sh
tapflow status
```

## Mac Resources

**경로**: `/mac-resources`

Mac 에이전트별 CPU·RAM 사용량을 확인합니다. 세션 배정 전에 과부하된 호스트를 미리 파악하는 데 유용합니다.

| 요소 | 설명 |
|------|------|
| Mac 목록 | 지금 연결된 Mac을 호스트명으로 보여 줍니다. 연결이 끊긴 Mac도 최근 30일 안에 사용량 기록이 있으면 목록에 남습니다. 초록 점이 붙은 Mac은 에이전트가 연결돼 있습니다. Mac을 고르면 차트가 열립니다. |
| 시계열 차트 | CPU %(파란색)와 RAM %(보라색) 히스토리. |
| 범위 선택 | **1h** / **6h** / **24h** / **7d** — 표시 기간을 전환합니다. |

데이터는 1분마다 샘플링되며 30일간 보관됩니다.
