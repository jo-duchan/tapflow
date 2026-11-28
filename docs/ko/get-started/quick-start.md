---
title: 빠른 시작
description: 운영자가 Mac 한 대에 tapflow를 설치하고 관리자 계정을 만든 뒤, 준비한 빌드를 올려 기기 화면을 처음 탭하기까지 따라 하는 튜토리얼입니다. 팀원을 초대하고 대시보드 주소를 보내는 방법도 다룹니다.
---

<a id="최초-설정"></a>

# 빠른 시작

Mac 한 대에 tapflow를 설치하고 준비한 빌드를 올려 브라우저에서 기기 화면을 처음 탭해 볼 때까지 안내합니다. 마지막 단계에서는 팀원을 초대해 같은 빌드를 테스트하게 합니다. 팀에서 초대 링크를 받은 팀원이라면 설치할 것이 없으니 [팀원 시작 가이드](/ko/get-started/teammates)로 가세요.

::: info 시작하기 전에
- **Apple Silicon(M 시리즈) Mac**: Intel Mac은 지원하지 않습니다. 지원하는 macOS와 Xcode 버전은 [시스템 요구사항](/ko/operate/requirements)에서 확인하세요.
- **Node.js 22 이상**
- **Mac 관리자 암호**: `tapflow setup`이 Homebrew·JDK 설치와 Xcode 초기 설정에서 sudo 암호를 묻습니다.
- **Apple 계정**: App Store에서 받든 Apple 개발자 사이트에서 받든 Xcode를 내려받으려면 Apple 계정으로 로그인해야 합니다.
- **테스트할 빌드**: iOS는 시뮬레이터용 `.app.zip` 또는 `.tar.gz`/`.tgz`, Android는 `.apk`입니다. 실제 기기용 `.ipa`는 올릴 수 없습니다. Android APK에는 `arm64-v8a` ABI가 들어 있어야 Apple Silicon 에뮬레이터에 설치됩니다. 빌드가 없다면 앱 개발자에게 시뮬레이터·에뮬레이터용 빌드를 요청하세요. CI에서 빌드를 만들어 올리는 방법은 [CI에서 빌드 올리기](/ko/operate/ci-distribution)에 있습니다.
- **걸리는 시간**: 대부분 `tapflow setup`의 다운로드 시간입니다. Xcode, 시뮬레이터 런타임, Android SDK와 시스템 이미지는 용량이 커서 처음 받을 때는 네트워크 속도에 따라 오래 걸립니다. 이미 설치되어 있으면 setup은 확인만 하고 넘어갑니다.
:::

<a id="_1-tapflow-설치"></a>

## 1. tapflow 설치 {#_1-install-tapflow}

::: code-group

```sh [npm]
npm install -g tapflow
```

```sh [yarn]
yarn global add tapflow
```

```sh [pnpm]
pnpm add -g tapflow
```

:::

<a id="_2-환경-준비"></a>

## 2. 환경 준비 {#_2-set-up-the-environment}

시뮬레이터와 에뮬레이터를 띄울 Mac에서 필요한 도구를 한 번에 설치합니다.

```sh
tapflow setup
```

setup은 설치가 필요한 단계마다 동의를 구합니다. Xcode는 setup이 직접 설치할 수 없어서 App Store를 열어 줍니다. Xcode 설치를 마치고 Enter를 누르면 다음 단계로 이어집니다. Xcode는 [Apple 개발자 사이트](https://developer.apple.com/xcode/)에서 받아도 됩니다. iOS 단계에서는 아래 macOS 확인 창이 뜰 수 있습니다.

- **오디오 녹음 권한**: 기기 소리를 브라우저로 보내는 데 필요합니다. **허용**(Allow)을 누릅니다.
- **시스템 확장 승인**: iOS 네트워크 제어에 쓰는 네트워크 필터를 설치하면 macOS가 승인을 요구합니다. 승인하지 않으면 setup이 `SETUP INCOMPLETE`로 끝나고 남은 일을 알려 줍니다. 네트워크 제어 외의 기능은 승인 없이도 동작합니다.

한 플랫폼만 쓴다면 `tapflow setup ios` 또는 `tapflow setup android`를 실행합니다.

setup이 끝나면 `tapflow doctor`로 준비 상태를 확인합니다. 단계별 설명은 [환경 준비](/ko/operate/environment-setup)를 참고하세요.

<a id="_3-tapflow-설정-선택"></a>

## 3. tapflow 설정 (선택) {#_3-configure-tapflow-optional}

기본값(포트 4000, 터널 없음, HTTP)으로 충분하면 이 단계를 건너뜁니다. 사무실 밖에서 접속할 터널이나 HTTPS가 필요할 때만 실행합니다.

```sh
tapflow init
```

터널, 스트리밍 성능(HTTP 또는 HTTPS), Lean 모드를 대화형으로 묻습니다. 질문마다 무엇을 정하는지, 설정 파일이 어디에 생기는지는 [tapflow 설정](/ko/operate/configure)에서 다룹니다.

<a id="_4-릴레이-에이전트-시작"></a>

## 4. 릴레이와 에이전트 시작 {#_4-start-the-relay-agent}

같은 Mac에서 실행합니다.

```sh
tapflow start
```

설치 폴더·설정·데이터 경로가 먼저 출력되고 릴레이와 에이전트가 준비되면 아래와 같은 배너가 나옵니다. Android 환경이 있으면 `android` 에이전트도 함께 연결됩니다. 첫 번째 에이전트가 연결에 실패하면 `start`는 오류 배너를 띄우고 멈춥니다. 다른 에이전트가 연결된 뒤에 실패한 에이전트는 ⚠ 줄로 알리고 나머지는 계속 실행됩니다.

```text
  →  Relay started on http://localhost:4000

  ✓  Connecting ios agent…

  ┌─────────────────────────────────────────────┐
  │  ✓  TAPFLOW READY                           │
  └─────────────────────────────────────────────┘
     Relay  : http://localhost:4000
     Open http://localhost:4000 in your browser.
     Press Ctrl+C to stop.
```

이 터미널은 닫지 말고 그대로 두세요. `Ctrl+C`를 누르면 릴레이와 에이전트가 함께 종료됩니다.

::: tip 릴레이를 다른 서버에 두려면
`tapflow relay start`와 `tapflow agent start`를 사용하세요. 자세한 내용은 [배포 방식 선택](/ko/operate/deployment)을 참고하세요.
:::

<a id="_5-관리자-계정-생성"></a>
<a id="_1-관리자-계정-생성"></a>

## 5. 관리자 계정 생성 {#_5-create-the-admin-account}

tapflow에는 기본 계정이 없습니다. 첫 계정은 Admin 역할을 받으며 이 Mac의 브라우저에서 만듭니다.

1. 이 Mac의 브라우저에서 `http://localhost:4000`을 엽니다. 계정이 하나도 없으면 **Set up tapflow** 화면(`/setup`)으로 이동합니다.
2. **Admin email**, **Password**(8자 이상), **Confirm password**를 입력합니다.
3. **Create admin account**를 누릅니다. 로그인 화면으로 이동합니다.

<a id="_2-로그인"></a>
<a id="_6-대시보드-열기"></a>

로그인 화면에서 방금 만든 이메일과 비밀번호를 입력하고 **Sign in**을 누르면 App Center가 열립니다.

::: warning 첫 계정은 이 Mac에서만 만들 수 있습니다
다른 컴퓨터에서 주소를 열면 입력 폼 대신 이 Mac에서 `tapflow admin init`을 실행하라는 안내가 나옵니다. 설정 화면은 계정이 하나도 없을 때만 나오고 이후 계정은 모두 초대로 만듭니다.
:::

::: tip 브라우저가 없는 서버
터미널에서 `tapflow admin init`을 실행하면 이메일과 비밀번호를 물어 관리자 계정을 만듭니다. 릴레이가 먼저 실행 중이어야 합니다. 사람이 입력할 수 없는 설치라면 `TAPFLOW_ADMIN_EMAIL`과 `TAPFLOW_ADMIN_PASSWORD`를 설정해 릴레이가 시작하면서 계정을 만들게 하세요. 자세한 내용은 [설정 파일](/ko/reference/configuration#create-the-first-admin-account-in-a-docker-container-tapflow-admin-email)을 참고하세요.
:::

<a id="_4-첫-번째-앱-추가"></a>

## 6. 빌드 업로드 {#upload-your-build}

1. App Center 오른쪽 위의 **Upload build**를 누릅니다.
2. **File** 영역을 클릭해 빌드 파일을 고르거나 파일을 끌어다 놓습니다.
3. **Upload**를 누릅니다. **Build uploaded** 알림이 뜨고 목록에 빌드가 추가됩니다.

tapflow가 파일에서 bundle ID, 버전, 빌드 번호를 읽어 앱 항목을 자동으로 만듭니다. 리뷰 상태, 앱을 먼저 등록하는 방법, CI에서 올리는 방법은 [App Center](/ko/testing/app-center#upload-a-build)를 참고하세요.

<a id="_5-세션-시작"></a>

## 7. QA 세션 시작 {#start-a-session}

1. 방금 올린 빌드 행에서 **Start QA**를 누릅니다.
2. **Select Mac** 화면에서 이 Mac의 카드를 고릅니다.
3. **Select device** 화면에서 기기를 클릭합니다. **Available** 기기는 고르면 켜집니다.

기기가 켜지면 빌드가 자동으로 설치됩니다. 기기 오른쪽 정보 카드에 **Starting device…**, **Installing app…**이 차례로 표시됩니다. 화면별 자세한 설명은 [QA 세션](/ko/testing/qa-session)을 참고하세요.

## 8. 앱 실행과 첫 탭 {#first-tap}

설치가 끝나면 툴바에 **Launch app** 버튼이 나타납니다. 이 버튼을 눌러 앱을 실행합니다.

이제 기기 화면을 클릭하면 탭이 되고 드래그하면 스와이프가 됩니다. 키보드로 입력하려면 기기 화면을 한 번 클릭한 뒤 입력합니다. 앱이 반응하면 설치는 끝났습니다. 다른 조작 방법은 [기기 조작](/ko/testing/device-controls)을 참고하세요.

## 9. 팀원 초대 {#invite-a-teammate}

팀원은 tapflow를 설치하지 않습니다. 초대 링크 하나만 받으면 브라우저로 가입하고 테스트합니다.

1. 대시보드 사이드바의 **Settings** 아래에서 **Team**을 엽니다. Admin에게만 보입니다.
2. **Invite member**를 누르고 **Email**과 **Role**을 정합니다. 역할의 기본값은 **QA**입니다.
3. **Generate invite link**를 누릅니다. 다이얼로그에 초대 링크가 표시됩니다.
4. 이 링크를 메신저나 메일로 팀원에게 보냅니다. 링크는 7일 동안 유효합니다.

이 Mac에서 `http://localhost:4000`으로 대시보드를 연 상태라면 초대 링크에는 `localhost` 대신 이 Mac의 LAN 주소가 들어갑니다. 링크에서 `/invite` 앞부분(예: `http://192.168.0.10:4000`)이 팀원이 앞으로 여는 대시보드 주소입니다. `tapflow init`에서 터널을 설정했다면 시작 배너의 `Public :` 줄에 나온 주소가 대신 들어갑니다. 터널 없이 설정 파일에 `relay.url`을 적어 두었다면 그 주소가 들어갑니다.

같은 네트워크에 있지 않은 팀원이 접속하려면 터널이 필요합니다. [외부 접속](/ko/operate/external-access)을 참고하세요. 역할별 권한과 멤버 관리는 [팀·역할·토큰](/ko/operate/team-and-roles#invite-teammates)에서 다룹니다.

## 다음 단계 {#next-steps}

- [팀원 시작 가이드](/ko/get-started/teammates): 초대받은 팀원이 가입하고 테스트하는 과정입니다. 링크와 함께 보내 주세요.
- [수동 QA](/ko/testing): QA 세션에서 쓸 수 있는 기능(딥 링크, 네트워크 제어, 녹화, 댓글 등)을 안내합니다.
- [AI 에이전트 QA](/ko/ai-agents): AI 에이전트가 MCP로 기기를 조작해 테스트하게 합니다.
- [자동화 QA](/ko/automation): 저장한 플로우를 CI에서 AI 모델 없이 재생합니다.
- [CI에서 빌드 올리기](/ko/operate/ci-distribution): 빌드를 손으로 올리지 않고 CI가 올리게 합니다.
- [배포 방식 선택](/ko/operate/deployment): 릴레이를 따로 두거나 Mac을 늘리는 구성을 고릅니다.
- [문제 해결](/ko/troubleshooting): 설치나 연결이 막히면 `tapflow doctor` 결과와 함께 여기서 증상을 찾습니다.

## 옮겨진 섹션 {#moved-sections}

예전 최초 설정 페이지(`/dashboard/setup`)의 나머지 섹션은 아래 페이지로 옮겨졌습니다.

- [팀·역할·토큰](/ko/operate/team-and-roles)
  - <a id="_3-팀원-초대" data-moved-to="/ko/operate/team-and-roles#_3-팀원-초대"></a>[팀원 초대](/ko/operate/team-and-roles#_3-팀원-초대)
- [팀원 시작 가이드](/ko/get-started/teammates)
  - <a id="_6-팀원에게-공유하기" data-moved-to="/ko/get-started/teammates#_6-팀원에게-공유하기"></a>[팀원에게 공유하기](/ko/get-started/teammates#_6-팀원에게-공유하기)
