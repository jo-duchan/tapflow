---
title: QA 세션
description: Mac과 기기를 골라 세션을 시작하고 기기 화면을 브라우저에서 조작하는 화면입니다. 세션에서 쓸 수 있는 기능마다 자세한 페이지로 안내합니다.
---

# QA 세션

QA 세션은 Mac에서 실행 중인 iOS 시뮬레이터나 Android 에뮬레이터를 브라우저로 보면서 직접 조작하는 화면입니다. 기기는 운영자의 Mac에서 돌아가므로 팀원은 아무것도 설치하지 않습니다. [App Center](/ko/testing/app-center)에서 빌드 행의 **Start QA**를 누르면 열립니다.

## 세션 시작 {#start-a-session}

### Mac 고르기 {#select-mac}

**Select Mac** 화면에는 이 플랫폼의 기기를 가진 Mac이 카드로 나옵니다. 카드마다 이름, 상태 점, 남은 슬롯 수(`2/4 slots`처럼 남은 수/전체 수), CPU와 RAM 사용률이 표시됩니다.

| 상태 점 | 의미 |
|---|---|
| 초록 | 여유 있음 |
| 노랑 | CPU나 RAM 사용률이 70% 이상 80% 이하 |
| 빨강 | CPU나 RAM 사용률이 80%를 넘음. CPU가 넘으면 카드를 누를 수 없습니다. RAM만 넘으면 이미 켜진 기기가 있을 때만 누를 수 있습니다 |
| 회색 | 사용률 보고가 없거나 30초 넘게 끊김. 카드에 **Stale**이 붙습니다 |

빨간 카드에 마우스를 올리면 **This Mac is currently overloaded. Try again later.**가 표시됩니다. 다른 Mac을 고르거나 잠시 뒤에 다시 시도하세요.

그 Mac에서 기기가 켜지는 중이면 카드에 **Starting a device**가 붙습니다. 이때는 CPU 사용률이 80%를 넘어도 카드를 누를 수 있습니다. 부팅이 CPU를 올리기 때문입니다. 한 Mac에서는 기기를 한 번에 하나씩 켭니다. 고른 기기를 켜야 하면 정보 카드에 **Another device is starting on this Mac. Yours starts next…**가 표시되고 최대 60초 기다린 뒤 켜집니다. Mac의 메모리가 심각하게 부족할 때는 **This Mac is low on memory. Yours starts when it frees up…**가 대신 표시되고 이때도 최대 60초 기다린 뒤 켜집니다.

### 기기 고르기 {#select-device}

**Select device** 화면에서 기기를 클릭하면 세션이 시작됩니다. 기기마다 상태가 표시됩니다.

- **Booted**: 이미 켜져 있는 기기입니다.
- **Available**: 꺼져 있고 바로 쓸 수 있는 기기입니다. 고르면 켜집니다.
- **In use**: 다른 팀원이 쓰고 있어 고를 수 없습니다.
- **Your session is waiting for you**: 연결이 끊긴 내 세션이 이 기기에서 기다리고 있습니다. 고르면 앱 상태 그대로 이어집니다.
- **Waiting for … to return**: 다른 팀원의 연결이 끊겨 기기가 그 팀원을 기다리고 있습니다. 고르면 누구의 세션인지와 기기가 꺼지기까지 남은 시간을 보여 주고 확인을 받습니다. 쓰기 시작하면 그 팀원의 세션은 끝나고 테스트하던 앱 상태도 사라집니다. 기기가 기다리는 동안 그 팀원이 돌아오면 누가 기기를 쓰고 있는지 알려 줍니다.
- **Not enough memory to start**: Mac의 RAM 사용률이 80%를 넘어 이 기기를 켤 수 없습니다. tapflow가 이미 켜 둔 기기는 고를 수 있습니다.

켜진 기기에 **Most services off**가 붙어 있으면 자동 실행이 백그라운드 서비스를 대부분 끈 채로 켠 기기입니다(`--service-tier slim`). 그 실행이 켜 두라고 지정한 서비스만 켜져 있습니다. 기기를 다시 켤 때까지 그대로입니다. 고른 뒤 툴바에서 재시작하면 서비스가 다시 켜집니다. 정보 카드에도 같은 안내가 표시됩니다.

**Search device…** 검색창으로 기기를 찾습니다. Admin이 붙인 이름과 기기 원래 이름 모두로 찾을 수 있습니다. OS 버전 필터(기본값 **Any version**)로 목록을 좁힙니다. **Any version**이면 목록이 OS 버전별 제목으로 나뉘고 최신 버전이 위에 옵니다. 묶음이 하나뿐이면 제목은 붙지 않습니다. 버전을 알 수 없는 기기는 맨 아래 **Other**에 모입니다. Android 에뮬레이터는 꺼져 있어도 시스템 이미지의 버전으로 묶입니다.

**Full reset** 스위치를 켜고 기기를 고르면 다른 앱을 포함한 그 기기의 데이터를 모두 지우고 시작합니다. 스위치를 끈 채로 시작해도 테스트할 빌드는 매번 새로 설치되므로 그 앱의 데이터는 지워진 상태로 시작합니다. [세션으로 돌아갈](#return-to-a-session) 때는 다시 설치하지 않습니다. 한 번만 적용되는 설정이라 기기를 고르는 순간 스위치가 다시 꺼집니다. 이 스위치는 Mac이 초기화를 지원할 때만 보입니다.

### 기기 목록 정리 {#organize-devices}

Mac에서 시뮬레이터나 에뮬레이터를 추가하거나 지우면 에이전트를 다시 시작하지 않아도 목록에 반영됩니다. 에이전트가 30초마다 기기 목록을 다시 읽으므로 35초쯤 안에 나타나거나 사라집니다. 누가 쓰고 있는 기기는 그 세션이 끝난 뒤에 목록에서 빠집니다. 릴레이와 에이전트가 모두 이 기능이 들어간 버전이어야 합니다.

- **즐겨찾기**: 기기 카드의 별을 누르면 그 기기가 목록 맨 위 **Favourites** 묶음으로 옮겨집니다. 즐겨찾기는 사람마다 따로 저장됩니다.
- **이름 바꾸기**(Admin): 카드의 ⋯ 메뉴에서 **Rename**을 고릅니다. 팀원 모두의 목록에 새 이름이 보이고 원래 이름은 그 아래 작게 표시됩니다. 이름을 비우고 저장하면 원래 이름으로 돌아갑니다.
- **숨기기**(Admin): ⋯ 메뉴에서 **Hide**를 고르면 팀원 모두의 목록에서 그 기기가 빠집니다. Admin은 **Show hidden** 스위치를 켜서 숨긴 기기를 볼 수 있습니다. 다시 보이게 하려면 ⋯ 메뉴의 **Show**를 고릅니다.

이름과 숨김은 릴레이에 저장되고 Mac의 시뮬레이터나 에뮬레이터는 바뀌지 않습니다. 대시보드 목록에만 적용되므로 MCP 클라이언트와 자동 실행은 숨긴 기기도 원래 이름으로 계속 씁니다.

### 앱 실행 {#launch}

기기가 켜지면 빌드가 자동으로 설치됩니다. 기기 오른쪽 정보 카드에 **Starting device…**, **Installing app…** 같은 진행 상태가 표시됩니다. 설치가 끝나면 툴바에 **Launch app** 버튼이 나타나고 이 버튼을 눌러 앱을 실행합니다. 자세한 내용은 [기기 조작](/ko/testing/device-controls#launch-the-app)을 참고하세요.

### 세션 나가기 {#leave-a-session}

화면 위쪽 경로 표시(breadcrumb)는 `앱 이름 › 빌드 › Mac › 기기` 순서입니다. 앞 단계를 누르면 그 단계로 돌아갑니다. 기기 화면을 떠나면 그 기기는 종료되므로 다른 팀원이 바로 쓸 수 있습니다.

브라우저 탭을 닫거나 연결이 끊기면 기기는 바로 꺼지지 않고 몇 분(기본 5분) 동안 나를 기다립니다. [세션으로 돌아가기](#return-to-a-session)를 참고하세요.

### 세션으로 돌아가기 {#return-to-a-session}

기기를 고르면 주소창의 URL에 세션이 담깁니다. 이 URL을 새로고침하거나 다시 열면 기기 목록에서 다시 고르지 않아도 같은 기기로 돌아갑니다. 같은 빌드가 기기에 남아 있으면 다시 설치하지 않으므로 로그인 상태 같은 앱 상태가 그대로 이어집니다. 연결이 잠깐 끊겼다가 다시 붙을 때도 마찬가지입니다.

연결이 끊기거나 탭을 닫으면 기기는 일정 시간(기본 5분) 동안 나를 기다린 뒤 꺼집니다. 그동안에는 다음 방법으로 돌아갈 수 있습니다.

- 같은 URL을 엽니다.
- App Center나 기기 목록 위에 뜨는 **Your session on … was interrupted** 안내에서 **Resume**을 누릅니다. 같은 계정이면 다른 브라우저에서도 됩니다. 기기를 바로 끄려면 **End**를 누릅니다.

URL로 돌아갈 때는 기기 상태에 따라 다음과 같이 안내합니다.

| 상황 | 안내 |
|---|---|
| 연결이 끊긴 사이 새로고침해서 이전 탭의 연결이 아직 남아 있습니다. | **Returning to your session on …** 안내가 뜨고 이전 연결이 정리되면 자동으로 이어집니다. 최대 약 45초가 걸립니다. 기다리는 동안에도 다른 기기를 고를 수 있습니다. |
| 같은 세션이 내 다른 탭에서 아직 열려 있습니다. | 같은 안내가 뜨고 그 탭이 닫히면 이어집니다. 약 45초가 지나도 열려 있으면 다른 탭에서 열려 있다고 알려 줍니다. |
| 기기가 이미 꺼졌습니다. | **Start … again?** 대화상자가 뜹니다. 다시 시작하면 빌드를 새로 설치합니다. |
| 다른 팀원이 기기를 쓰기 시작했습니다. | 누가 쓰고 있는지 알림으로 알려 주고 기기 목록을 보여 줍니다. |
| AI 클라이언트가 기기를 잠시 쓰고 있습니다. | 쓰는 중이라는 안내가 뜨고 끝나면 이어갈 수 있습니다. |

tapflow 밖에서 기기를 껐다 켰다면(Simulator.app 종료 등) 돌아갈 때 빌드를 다시 설치합니다. 기기에서 앱을 직접 지웠다면 돌아가도 앱이 없으니 기기를 다시 골라 설치합니다.

## 세션에서 할 수 있는 일 {#features}

| 기능 | 설명 |
|---|---|
| [화면 조작](/ko/testing/device-controls#touch-and-gestures) | 클릭으로 터치하고 드래그로 스와이프합니다. Option(Alt)을 누른 채 드래그하면 핀치입니다. |
| [키 입력](/ko/testing/device-controls#typing) | 기기 화면을 한 번 클릭한 뒤 키보드로 입력합니다. |
| [앱 실행](/ko/testing/device-controls#launch-the-app) | 설치된 빌드를 **Launch app**으로 실행합니다. |
| [기기 버튼](/ko/testing/device-controls#device-buttons) | iOS의 Home과 기기 테두리의 측면 버튼, Android의 **Home**·**Back**·**Recent Apps**·**Volume Up**·**Volume Down**·**Power**를 누릅니다. |
| [소프트웨어 키보드](/ko/testing/device-controls#software-keyboard) | iOS 화면 키보드를 올리거나 내립니다. |
| [회전](/ko/testing/device-controls#rotate) | iOS와 gRPC로 켠 Android 에뮬레이터는 시계 방향으로 90°씩 돌립니다. Android 실기기와 gRPC 없이 켠 에뮬레이터는 세로와 가로를 오갑니다. |
| [접기와 펼치기](/ko/testing/device-controls#fold) | 폴더블 Android 에뮬레이터나 iPhone Duo를 접거나 펼칩니다. |
| [기기 재시작](/ko/testing/device-controls#restart) | 기기를 다시 켭니다. 테스트 중인 빌드는 새로 설치되고 다른 앱의 데이터는 남습니다. |
| [클립보드](/ko/testing/device-controls#clipboard) | 기기와 내 컴퓨터 사이에서 텍스트를 복사하고 붙여 넣습니다. |
| [딥 링크](/ko/testing/deep-links) | URL을 입력해 앱의 특정 화면을 바로 엽니다. |
| [네트워크 제어](/ko/testing/network-control) | 기기를 오프라인으로 만들었다가 다시 연결합니다. |
| [오디오](/ko/testing/audio) | 기기 소리를 브라우저에서 듣습니다. |
| [스크린샷](/ko/testing/screenshots-and-recordings#screenshots) | 기기 화면을 PNG로 내려받습니다. |
| [녹화](/ko/testing/screenshots-and-recordings#recordings) | 기기 화면을 영상으로 녹화해 팀과 공유합니다. |
| [댓글](/ko/testing/comments) | 빌드에 글과 이미지를 남깁니다. |
| [키보드 단축키](#keyboard-shortcuts) | 자주 쓰는 기능을 단축키로 실행합니다. |

기능 버튼은 기기 오른쪽 툴바에 Navigation(이동), Device(기기 상태), Capture(캡처), Environment(환경) 네 묶음으로 놓여 있습니다. Mac이 지원하지 않는 기능의 버튼은 보이지 않습니다.

## 정보 카드 {#info-card}

기기 오른쪽 정보 카드에는 세션 상태가 표시됩니다.

- **Focus**: 키 입력이 기기로 가는 동안 초록색으로 바뀝니다.
- **fps**: 초당 받는 화면 수입니다. 15를 넘으면 **Active**, 그 이하이면 **Idle**로 표시됩니다. 화면이 멈춰 있으면 수치가 낮은 것이 정상입니다.
- **Smooth** / **Standard**: 이 브라우저가 받는 스트림 프로파일입니다. **Standard**를 누르면 Smooth로 바꾸는 조건을 안내하는 창이 열립니다. 프로파일은 [스트림 품질](/ko/operate/streaming-quality)을 참고하세요.

카드 아래쪽 탭에서 [댓글](/ko/testing/comments)(**Comments**)과 [녹화](/ko/testing/screenshots-and-recordings#recordings)(**Recordings**)를 봅니다.

## 키보드 단축키 {#keyboard-shortcuts}

아래 단축키는 대시보드의 입력창에 커서가 있을 때는 동작하지 않습니다.

| 단축키 | 동작 | 플랫폼 |
|---|---|---|
| <kbd>⌘</kbd> <kbd>K</kbd> | [딥 링크](/ko/testing/deep-links) 입력창 열기 | iOS, Android |
| <kbd>⌘</kbd> <kbd>S</kbd> | [스크린샷](/ko/testing/screenshots-and-recordings#screenshots) | iOS, Android |
| <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>Y</kbd> | [녹화](/ko/testing/screenshots-and-recordings#recordings) 시작·중지 | iOS, Android |
| <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>O</kbd> | [회전](/ko/testing/device-controls#rotate) | iOS, Android |
| <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>U</kbd> | [Home 버튼](/ko/testing/device-controls#device-buttons) | iOS |
| <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>K</kbd> | [소프트웨어 키보드](/ko/testing/device-controls#software-keyboard) 올리기·내리기 | iOS |
| <kbd>⌥</kbd> + 드래그 | [핀치](/ko/testing/device-controls#touch-and-gestures) | iOS, Android |
| <kbd>⌘</kbd>/<kbd>Ctrl</kbd> <kbd>C</kbd>·<kbd>X</kbd>·<kbd>V</kbd> | [클립보드](/ko/testing/device-controls#clipboard) 복사·잘라내기·붙여넣기 | iOS, Android |

그 밖의 키는 기기 화면을 클릭한 뒤 누르면 기기로 전달됩니다.

## 제한 사항 {#limits}

- 한 기기는 한 번에 한 사람만 씁니다. 다른 팀원이 쓰는 기기는 **In use**로 표시되고 고를 수 없습니다.
- 기기 화면을 떠나면 기기가 종료됩니다. 화면에 띄워 둔 상태는 남지 않고 다른 앱의 데이터는 남습니다. 테스트할 빌드는 다음 세션을 시작할 때 다시 설치되므로 그 앱의 데이터는 이어지지 않습니다.

## 문제 해결 {#troubleshooting}

세션이 끊기면 대시보드가 이유를 알림으로 보여 주고 Mac 목록으로 돌아갑니다.

| 알림 | 원인과 조치 |
|---|---|
| **`The agent disconnected — this session ended.`** | Mac 쪽 연결이 끊겼습니다. Mac을 다시 골라 새 세션을 시작합니다. |
| **This device is already open in another browser session.** | 다른 사람이 그 기기를 쓰고 있습니다. 연결이 끊긴 사이 새로고침했다면 내 이전 탭이 기기를 잡고 있으며 약 45초 안에 풀립니다. |
| **That Mac is too busy to start a session.** | Mac의 CPU나 RAM이 한도를 넘었습니다. 다른 Mac을 고르거나 잠시 기다립니다. |

스트림이 끊기거나 느리면 [스트림과 세션 문제 해결](/ko/troubleshooting/streaming)을 참고하세요.

## 관련 문서 {#related}

- [App Center](/ko/testing/app-center): 빌드를 고르고 리뷰 상태를 바꾸는 화면
- [기기 조작](/ko/testing/device-controls): 터치, 버튼, 회전, 클립보드 등 기기를 다루는 방법
- [스트림 품질](/ko/operate/streaming-quality): Smooth와 Standard 프로파일의 차이
