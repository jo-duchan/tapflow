# 빠른 시작

tapflow를 설치하고 대시보드를 여는 과정을 안내합니다. Xcode나 Android SDK를 새로 받아야 한다면 `tapflow setup` 단계에서 다운로드 시간이 추가로 걸립니다.

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

에이전트를 실행할 Mac에서는 시뮬레이터/에뮬레이터 사전 요건을 한 번에 설치합니다.

```sh
tapflow setup
```

릴레이만 운영하는 서버(Linux)에서는 건너뜁니다. 자세한 내용은 [환경 준비](/ko/operate/environment-setup)를 참고하세요.

<a id="_3-tapflow-설정-선택"></a>

## 3. tapflow 설정 (선택) {#_3-configure-tapflow-optional}

`tapflow init`을 실행해 이 머신을 설정합니다. `~/.tapflow`에 `tapflow.config.json`을 쓰고, 터널을 묻고, 터널 없이 LAN으로 쓸 때는 스트리밍 성능(HTTP 또는 HTTPS)까지 대화형으로 물어봅니다. 시뮬레이터나 에뮬레이터를 돌릴 수 있는 머신이면 Lean 모드를 켤지도 묻습니다. 기본값(포트 4000, 터널 없음, HTTP)으로 충분하다면 이 단계를 건너뛸 수 있습니다.

```sh
tapflow init
```

어느 폴더에서 실행해도 됩니다. tapflow는 머신마다 설치 폴더 하나를 쓰고, 모든 명령이 같은 방식으로 그 폴더를 찾습니다. 서버의 `/var/lib/tapflow`처럼 다른 곳에 두려면 `TAPFLOW_HOME`을 설정하세요. 모든 명령이 그 값을 따릅니다.

`init`은 그 폴더에 `AGENTS.md`와 `CLAUDE.md`도 씁니다. 그 폴더에서 연 코딩 에이전트가 tapflow 질문에 공식 문서를 근거로 답합니다. 각 프롬프트가 무엇을 설정하는지, `.env` 자격 증명 파일과 CI 플래그는 어떻게 쓰는지는 [tapflow 설정](/ko/operate/configure)에서 다룹니다.

<a id="_4-릴레이-에이전트-시작"></a>

## 4. 릴레이 + 에이전트 시작 {#_4-start-the-relay-agent}

Mac에서 실행하세요:

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

::: tip 릴레이를 서버에 따로 띄우려면
`tapflow relay start`와 `tapflow agent start`를 사용하세요. 자세한 내용은 [릴레이 배포](/ko/guide/self-hosting)를 참고하세요.
:::

<a id="_5-관리자-계정-생성"></a>

## 5. 관리자 계정 생성 {#_5-create-the-admin-account}

tapflow는 기본 인증 정보가 없습니다. 최초 실행 시 대시보드가 설정 페이지로 자동 이동합니다:

1. 브라우저에서 `http://localhost:4000`을 엽니다.
2. `/setup` 페이지로 자동으로 이동합니다.
3. 이메일과 비밀번호를 입력해 관리자 계정을 생성합니다.

::: warning 최초 1회만 가능
설정 페이지는 계정이 하나도 없을 때만 표시됩니다. 이후 팀원 추가는 대시보드 **Settings → Team**에서 초대로 진행합니다.
:::

::: tip 브라우저 없는 서버 환경이라면?
`tapflow admin init`을 실행해 CLI에서 최초 관리자 계정을 생성할 수 있습니다.
:::

<a id="_6-대시보드-열기"></a>

## 6. 대시보드 열기 {#_6-open-the-dashboard}

브라우저에서 `http://localhost:4000`에 접속한 뒤, 방금 생성한 계정으로 로그인합니다.

팀 초대 및 첫 번째 빌드 업로드까지 포함한 전체 온보딩 과정은 [최초 설정](/ko/dashboard/setup)을 참고하세요.

::: tip 환경 점검
설정 중 문제가 생기면 `tapflow doctor`를 실행하세요. Node.js 버전과 각 플랫폼에 필요한 도구들을 자동으로 진단합니다.
:::
