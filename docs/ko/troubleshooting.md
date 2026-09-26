---
title: 문제 해결
description: tapflow 문제의 해결 방법을 설치와 에이전트, iOS 시뮬레이터, Android 에뮬레이터, 빌드, 스트림, 로그인 영역별로 모았습니다. 릴레이 로그 확인 방법도 있습니다.
---

# 문제 해결

문제는 영역별로 한 페이지씩 나뉘어 있습니다.

- [설치와 에이전트](/ko/troubleshooting/install-and-agents)
- [iOS 시뮬레이터](/ko/troubleshooting/ios-simulator)
- [Android 에뮬레이터](/ko/troubleshooting/android-emulator)
- [빌드와 업로드](/ko/troubleshooting/builds)
- [스트림과 세션](/ko/troubleshooting/streaming)
- [로그인과 계정](/ko/troubleshooting/accounts)

## 로그 확인

릴레이 호스트에서 다음 명령으로 릴레이의 동작 로그를 확인할 수 있습니다. 릴레이는 다른 기기에는 로그를 보여 주지 않습니다.

```sh
tapflow logs
tapflow logs --lines 200
```

Docker로 운영한다면 컨테이너 밖의 CLI는 원격으로 취급되므로 `docker compose logs`로 확인하세요.

## 옮겨진 섹션 {#moved-sections}

이 페이지에 있던 섹션은 아래 페이지로 옮겨졌습니다.

- [설치와 에이전트](/ko/troubleshooting/install-and-agents)
  - <a id="에이전트-연결-문제" data-moved-to="/ko/troubleshooting/install-and-agents#에이전트-연결-문제"></a>[에이전트 연결 문제](/ko/troubleshooting/install-and-agents#에이전트-연결-문제)
  - <a id="agent-already-running" data-moved-to="/ko/troubleshooting/install-and-agents#agent-already-running"></a>[이미 에이전트가 실행 중이라고 나옴](/ko/troubleshooting/install-and-agents#agent-already-running)
  - <a id="에이전트가-릴레이에-연결되지-않음" data-moved-to="/ko/troubleshooting/install-and-agents#에이전트가-릴레이에-연결되지-않음"></a>[에이전트가 릴레이에 연결되지 않음](/ko/troubleshooting/install-and-agents#에이전트가-릴레이에-연결되지-않음)
  - <a id="tapflow-doctor-실패" data-moved-to="/ko/troubleshooting/install-and-agents#tapflow-doctor-실패"></a>[`tapflow doctor` 실패](/ko/troubleshooting/install-and-agents#tapflow-doctor-실패)
  - <a id="ios-항목이-모두-실패함" data-moved-to="/ko/troubleshooting/install-and-agents#ios-항목이-모두-실패함"></a>[iOS 항목이 모두 실패함](/ko/troubleshooting/install-and-agents#ios-항목이-모두-실패함)
  - <a id="xcode-not-found-—-xcode가-설치되어-있지-않은-경우" data-moved-to="/ko/troubleshooting/install-and-agents#xcode-not-found-—-xcode가-설치되어-있지-않은-경우"></a>[`Xcode not found` — Xcode가 설치되어 있지 않은 경우](/ko/troubleshooting/install-and-agents#xcode-not-found-—-xcode가-설치되어-있지-않은-경우)
  - <a id="xcode-not-found-—-xcode는-설치되어-있지만-xcode-select가-설정되지-않은-경우" data-moved-to="/ko/troubleshooting/install-and-agents#xcode-not-found-—-xcode는-설치되어-있지만-xcode-select가-설정되지-않은-경우"></a>[`Xcode not found` — Xcode는 설치되어 있지만 `xcode-select`가 설정되지 않은 경우](/ko/troubleshooting/install-and-agents#xcode-not-found-—-xcode는-설치되어-있지만-xcode-select가-설정되지-않은-경우)
  - <a id="실행-중인-시뮬레이터가-없는-경우" data-moved-to="/ko/troubleshooting/install-and-agents#실행-중인-시뮬레이터가-없는-경우"></a>[실행 중인 시뮬레이터가 없는 경우](/ko/troubleshooting/install-and-agents#실행-중인-시뮬레이터가-없는-경우)
  - <a id="adb-not-found" data-moved-to="/ko/troubleshooting/install-and-agents#adb-not-found"></a>[`adb not found`](/ko/troubleshooting/install-and-agents#adb-not-found)
  - <a id="tapflow-init이-config-kept라고-합니다" data-moved-to="/ko/troubleshooting/install-and-agents#tapflow-init이-config-kept라고-합니다"></a>[`tapflow init`이 `CONFIG KEPT`라고 합니다](/ko/troubleshooting/install-and-agents#tapflow-init이-config-kept라고-합니다)
  - <a id="릴레이가-예상과-다른-설정이나-db를-씁니다" data-moved-to="/ko/troubleshooting/install-and-agents#릴레이가-예상과-다른-설정이나-db를-씁니다"></a>[릴레이가 예상과 다른 설정이나 DB를 씁니다](/ko/troubleshooting/install-and-agents#릴레이가-예상과-다른-설정이나-db를-씁니다)
- [iOS 시뮬레이터](/ko/troubleshooting/ios-simulator)
  - <a id="spawn-unknown-error" data-moved-to="/ko/troubleshooting/ios-simulator#spawn-unknown-error"></a>[빌드를 열면 `spawn unknown error`가 납니다](/ko/troubleshooting/ios-simulator#spawn-unknown-error)
  - <a id="ios-simulator-service-version-mismatch" data-moved-to="/ko/troubleshooting/ios-simulator#ios-simulator-service-version-mismatch"></a>[iOS 시뮬레이터 서비스 버전 불일치](/ko/troubleshooting/ios-simulator#ios-simulator-service-version-mismatch)
  - <a id="simulator-data-missing" data-moved-to="/ko/troubleshooting/ios-simulator#simulator-data-missing"></a>[iOS 시뮬레이터가 부팅되지 않음 — "cannot be located on disk"](/ko/troubleshooting/ios-simulator#simulator-data-missing)
  - <a id="ios-17-이하-—-한글-입력-시-자모-분리" data-moved-to="/ko/troubleshooting/ios-simulator#ios-17-이하-—-한글-입력-시-자모-분리"></a>[iOS 17 이하 — 한글 입력 시 자모 분리](/ko/troubleshooting/ios-simulator#ios-17-이하-—-한글-입력-시-자모-분리)
- [빌드와 업로드](/ko/troubleshooting/builds)
  - <a id="ios-빌드-업로드-오류" data-moved-to="/ko/troubleshooting/builds#ios-빌드-업로드-오류"></a>[iOS 빌드 업로드 오류](/ko/troubleshooting/builds#ios-빌드-업로드-오류)
  - <a id="업로드-시-400-오류" data-moved-to="/ko/troubleshooting/builds#업로드-시-400-오류"></a>[업로드 시 `400` 오류](/ko/troubleshooting/builds#업로드-시-400-오류)
  - <a id="install-failed-no-matching-abis-—-apple-silicon-에뮬레이터와-호환되지-않는-apk" data-moved-to="/ko/troubleshooting/builds#install-failed-no-matching-abis-—-apple-silicon-에뮬레이터와-호환되지-않는-apk"></a>[`INSTALL_FAILED_NO_MATCHING_ABIS` — Apple Silicon 에뮬레이터와 호환되지 않는 APK](/ko/troubleshooting/builds#install-failed-no-matching-abis-—-apple-silicon-에뮬레이터와-호환되지-않는-apk)
  - <a id="apk-업로드가-unversioned-로-표시되거나-다른-앱에-병합됨" data-moved-to="/ko/troubleshooting/builds#apk-업로드가-unversioned-로-표시되거나-다른-앱에-병합됨"></a>[APK 업로드가 'Unversioned'로 표시되거나 다른 앱에 병합됨](/ko/troubleshooting/builds#apk-업로드가-unversioned-로-표시되거나-다른-앱에-병합됨)
- [Android 에뮬레이터](/ko/troubleshooting/android-emulator)
  - <a id="android-에뮬레이터-문제" data-moved-to="/ko/troubleshooting/android-emulator"></a>[Android 에뮬레이터 문제](/ko/troubleshooting/android-emulator)
  - <a id="스트림이-시작되지-않거나-인코더-크래시" data-moved-to="/ko/troubleshooting/android-emulator#스트림이-시작되지-않거나-인코더-크래시"></a>[스트림이 시작되지 않거나 인코더 크래시](/ko/troubleshooting/android-emulator#스트림이-시작되지-않거나-인코더-크래시)
  - <a id="색이-에뮬레이터와-다르게-보임-채도가-낮음" data-moved-to="/ko/troubleshooting/android-emulator#색이-에뮬레이터와-다르게-보임-채도가-낮음"></a>[색이 에뮬레이터와 다르게 보임 (채도가 낮음)](/ko/troubleshooting/android-emulator#색이-에뮬레이터와-다르게-보임-채도가-낮음)
  - <a id="무인-상태에서-에뮬레이터가-느려짐" data-moved-to="/ko/troubleshooting/android-emulator#무인-상태에서-에뮬레이터가-느려짐"></a>[무인 상태에서 에뮬레이터가 느려짐](/ko/troubleshooting/android-emulator#무인-상태에서-에뮬레이터가-느려짐)
- [iOS 네트워크 확장](/ko/operate/network-extension)
  - <a id="network-not-set-up" data-moved-to="/ko/operate/network-extension#network-not-set-up"></a>[iOS: 네트워크 확장이 설치되지 않았습니다](/ko/operate/network-extension#network-not-set-up)
  - <a id="_1-설치" data-moved-to="/ko/operate/network-extension#_1-설치"></a>[1. 설치](/ko/operate/network-extension#_1-설치)
  - <a id="_2-승인" data-moved-to="/ko/operate/network-extension#_2-승인"></a>[2. 승인](/ko/operate/network-extension#_2-승인)
  - <a id="_3-재시작이-필요한-경우" data-moved-to="/ko/operate/network-extension#_3-재시작이-필요한-경우"></a>[3. 재시작이 필요한 경우](/ko/operate/network-extension#_3-재시작이-필요한-경우)
  - <a id="무엇이-설치돼-있는지-확인" data-moved-to="/ko/operate/network-extension#무엇이-설치돼-있는지-확인"></a>[무엇이 설치돼 있는지 확인](/ko/operate/network-extension#무엇이-설치돼-있는지-확인)
  - <a id="그래도-안-될-때" data-moved-to="/ko/operate/network-extension#그래도-안-될-때"></a>[그래도 안 될 때](/ko/operate/network-extension#그래도-안-될-때)
  - <a id="network-lost-on-replace" data-moved-to="/ko/operate/network-extension#network-lost-on-replace"></a>[iOS: 필터를 교체하는 중에 맥의 네트워크가 끊겼습니다](/ko/operate/network-extension#network-lost-on-replace)
  - <a id="network-stopped" data-moved-to="/ko/operate/network-extension#network-stopped"></a>[iOS: 오프라인이던 기기가 스스로 온라인으로 돌아왔습니다](/ko/operate/network-extension#network-stopped)
- [스트림과 세션](/ko/troubleshooting/streaming)
  - <a id="세션-관련" data-moved-to="/ko/troubleshooting/streaming#세션-관련"></a>[세션 관련](/ko/troubleshooting/streaming#세션-관련)
  - <a id="세션이-자동으로-종료됨" data-moved-to="/ko/troubleshooting/streaming#세션이-자동으로-종료됨"></a>[세션이 자동으로 종료됨](/ko/troubleshooting/streaming#세션이-자동으로-종료됨)
  - <a id="stream-lag" data-moved-to="/ko/troubleshooting/streaming#stream-lag"></a>[스트림 지연·끊김](/ko/troubleshooting/streaming#stream-lag)
  - <a id="lan-유선-권장" data-moved-to="/ko/troubleshooting/streaming#lan-유선-권장"></a>[LAN 유선 권장](/ko/troubleshooting/streaming#lan-유선-권장)
  - <a id="wi-fi에서-약-0-5초-주기로-끊기는-경우-awdl" data-moved-to="/ko/troubleshooting/streaming#wi-fi에서-약-0-5초-주기로-끊기는-경우-awdl"></a>[Wi-Fi에서 약 0.5초 주기로 끊기는 경우 (AWDL)](/ko/troubleshooting/streaming#wi-fi에서-약-0-5초-주기로-끊기는-경우-awdl)
  - <a id="호스트-cpu·ram-부족" data-moved-to="/ko/troubleshooting/streaming#호스트-cpu·ram-부족"></a>[호스트 CPU·RAM 부족](/ko/troubleshooting/streaming#호스트-cpu·ram-부족)
  - <a id="디스플레이-절전" data-moved-to="/ko/troubleshooting/streaming#디스플레이-절전"></a>[디스플레이 절전](/ko/troubleshooting/streaming#디스플레이-절전)
  - <a id="lan에서-화면이-흐리거나-해상도가-낮은-경우" data-moved-to="/ko/troubleshooting/streaming#lan에서-화면이-흐리거나-해상도가-낮은-경우"></a>[LAN에서 화면이 흐리거나 해상도가 낮은 경우](/ko/troubleshooting/streaming#lan에서-화면이-흐리거나-해상도가-낮은-경우)
- [로그인과 계정](/ko/troubleshooting/accounts)
  - <a id="인증-관련" data-moved-to="/ko/troubleshooting/accounts"></a>[인증 관련](/ko/troubleshooting/accounts)
  - <a id="tapflow-admin-init-실패-already-initialized" data-moved-to="/ko/troubleshooting/accounts#tapflow-admin-init-실패-already-initialized"></a>[`tapflow admin init` 실패 (`Already initialized`)](/ko/troubleshooting/accounts#tapflow-admin-init-실패-already-initialized)
  - <a id="초대-링크가-만료됨" data-moved-to="/ko/troubleshooting/accounts#초대-링크가-만료됨"></a>[초대 링크가 만료됨](/ko/troubleshooting/accounts#초대-링크가-만료됨)
  - <a id="비밀번호-재설정-링크가-만료됨" data-moved-to="/ko/troubleshooting/accounts#비밀번호-재설정-링크가-만료됨"></a>[비밀번호 재설정 링크가 만료됨](/ko/troubleshooting/accounts#비밀번호-재설정-링크가-만료됨)
