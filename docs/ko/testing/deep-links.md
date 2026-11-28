---
title: 딥 링크
description: URL을 입력해 QA 세션의 기기에서 앱의 특정 화면을 바로 엽니다. 툴바 버튼이나 ⌘K로 입력창을 엽니다.
---

# 딥 링크

딥 링크는 앱의 특정 화면을 여는 URL입니다(예: `myapp://settings`). QA 세션에서 딥 링크를 입력하면 첫 화면부터 탭해 들어가지 않고 확인할 화면으로 바로 갑니다. 따로 켤 설정은 없습니다.

<!-- 영상 자리: 클립을 docs/public/media/에 넣은 뒤 이 주석을 <VideoPlayer src="/media/파일.mp4" poster="/media/파일.png" />로 바꿉니다. -->

## 사용 방법 {#how-to-use}

1. 앱이 설치된 기기에서 툴바의 링크 아이콘 버튼(툴팁 **Deeplink**, 접근성 이름 **Open a deeplink**)을 누르거나 <kbd>⌘</kbd> <kbd>K</kbd>를 누릅니다.
2. 입력창(**Deeplink URL**)에 URL을 입력합니다.
3. <kbd>Enter</kbd>를 누르거나 **Open**을 누릅니다.

기기가 URL을 열면 **Deeplink opened** 알림이 뜹니다. 실패하면 기기가 보낸 오류 메시지가 알림으로 뜹니다. 입력창은 열 때마다 비어 있습니다.

## 플랫폼 지원 {#platform-support}

| | iOS | Android |
|---|---|---|
| 지원 | 지원 | 지원 |
| URL을 여는 방식 | 시뮬레이터에 URL 열기를 요청합니다(`simctl openurl`) | 에뮬레이터에 URL 보기 인텐트를 보냅니다(`am start -a android.intent.action.VIEW`) |

두 플랫폼 모두 폰에서 링크를 탭했을 때처럼 URL을 처리할 앱을 기기가 고릅니다.

## 제한 사항 {#limits}

- URL을 처리할 앱이 기기에 설치되어 있고 그 URL 스킴을 등록해 두어야 합니다. 먼저 [앱을 실행](/ko/testing/device-controls#launch-the-app)해 설치가 끝났는지 확인합니다.
- 대시보드의 다른 입력창에 커서가 있을 때는 <kbd>⌘</kbd> <kbd>K</kbd>가 동작하지 않습니다.

## 문제 해결 {#troubleshooting}

- **알림은 떴지만 원하는 화면이 열리지 않습니다.** URL을 받는 쪽은 앱입니다. 앱이 그 경로를 처리하는지 개발자에게 확인합니다. Android에서는 그 URL 스킴을 등록한 앱이 기기에 없어도 **Deeplink opened**가 뜰 수 있습니다.
- **`no booted device` 또는 `No booted device` 오류가 뜹니다.** 기기가 아직 켜지는 중이거나 세션이 끊긴 상태입니다. 정보 카드의 진행 상태가 사라진 뒤 다시 시도합니다.
- **세션이 계속 끊깁니다.** [스트림과 세션](/ko/troubleshooting/streaming)을 참고하세요.

## 관련 문서 {#related}

- [QA 세션](/ko/testing/qa-session): 세션에서 쓸 수 있는 기능과 키보드 단축키
- [기기 조작](/ko/testing/device-controls): 앱 실행과 기기 버튼
