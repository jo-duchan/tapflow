---
title: 앱 테스트
description: 팀원이 브라우저로 빌드를 테스트하는 방법입니다. App Center에서 빌드를 고르고 QA 세션에서 시뮬레이터나 에뮬레이터를 직접 조작한 뒤 결과를 남깁니다.
---

<a id="대시보드-개요"></a>

# 앱 테스트

이 섹션은 브라우저로 빌드를 확인하는 팀원을 위한 안내입니다. tapflow 자체는 설치할 것이 없고 운영자에게 받은 tapflow 대시보드 주소와 계정만 있으면 됩니다. 운영자가 Tailscale로 대시보드를 열어 두었다면 Tailscale 앱도 설치하세요([Tailscale](/ko/operate/external-access#tailscale-권장)).

대시보드는 tapflow가 제공하는 웹 화면입니다. 기기(iOS 시뮬레이터나 Android 에뮬레이터)는 운영자가 준비한 Mac에서 실행됩니다. 여러분은 그 화면을 브라우저로 보면서 조작합니다.

## 테스트 흐름 {#testing-flow}

1. **App Center**에서 앱과 빌드를 고릅니다. App Center는 대시보드 안의 빌드 목록 화면으로, Microsoft App Center와는 관계가 없습니다.
2. 빌드 행의 **Start QA**를 눌러 QA 세션을 엽니다. QA 세션은 기기 화면을 브라우저로 스트리밍하고 여러분의 클릭과 키 입력을 기기로 보내는 화면입니다.
3. Mac과 기기를 고르면 빌드가 기기에 설치됩니다. 앱을 실행해 확인하고 댓글이나 녹화로 발견한 내용을 남깁니다.
4. App Center에서 빌드의 리뷰 상태를 바꿔 결과를 팀에 알립니다.

## 이 섹션의 페이지 {#pages}

- [App Center](/ko/testing/app-center): 빌드 목록, 빌드 업로드, 검색과 상태 필터, 리뷰 상태, 삭제 예약을 다룹니다.
- [QA 세션](/ko/testing/qa-session): Mac과 기기를 골라 세션을 시작하는 방법과 세션에서 쓸 수 있는 기능 목록입니다.
  - [기기 조작](/ko/testing/device-controls): 터치, 스와이프, 핀치, 키 입력, 기기 버튼, 회전, 재시작, 클립보드를 다룹니다.
  - [딥 링크](/ko/testing/deep-links): URL을 입력해 앱의 특정 화면을 바로 엽니다.
  - [네트워크 제어](/ko/testing/network-control): 기기를 오프라인으로 만들었다가 다시 연결합니다.
  - [오디오](/ko/testing/audio): 기기 소리를 브라우저에서 듣습니다.
  - [스크린샷과 녹화](/ko/testing/screenshots-and-recordings): 화면을 이미지로 저장하거나 영상으로 녹화합니다.
  - [댓글](/ko/testing/comments): 빌드에 글과 이미지를 남겨 팀과 공유합니다.
  - [Flow Capture](/ko/testing/flow-capture): 세션에서 한 동작을 플로우 YAML로 저장합니다.

## 옮겨진 섹션 {#moved-sections}

이 페이지에 있던 섹션은 아래 페이지로 옮겨졌습니다.

- [App Center](/ko/testing/app-center)
  - <a id="app-center" data-moved-to="/ko/testing/app-center#app-center"></a>[App Center](/ko/testing/app-center#app-center)
- [QA 세션](/ko/testing/qa-session)
  - <a id="qa-세션" data-moved-to="/ko/testing/qa-session#qa-세션"></a>[QA 세션](/ko/testing/qa-session#qa-세션)
- [Mac 리소스 확장](/ko/operate/scaling)
  - <a id="mac-resources" data-moved-to="/ko/operate/scaling#mac-resources"></a>[Mac Resources](/ko/operate/scaling#mac-resources)
- [팀·역할·토큰](/ko/operate/team-and-roles)
  - <a id="settings" data-moved-to="/ko/operate/team-and-roles"></a>[Settings](/ko/operate/team-and-roles)
  - <a id="team" data-moved-to="/ko/operate/team-and-roles#team"></a>[Team](/ko/operate/team-and-roles#team)
  - <a id="tokens" data-moved-to="/ko/operate/team-and-roles#tokens"></a>[Tokens](/ko/operate/team-and-roles#tokens)
- [팀원 시작 가이드](/ko/get-started/teammates)
  - <a id="default" data-moved-to="/ko/get-started/teammates#default"></a>[Default](/ko/get-started/teammates#default)
