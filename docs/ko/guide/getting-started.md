# 빠른 시작

tapflow는 5분 안에 실행할 수 있습니다.

## 1. tapflow 설치

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

## 2. 환경 준비

에이전트를 실행할 Mac에서는 시뮬레이터/에뮬레이터 사전 요건을 한 번에 설치합니다.

```sh
tapflow setup
```

릴레이만 운영하는 서버(Linux)에서는 건너뜁니다. 자세한 내용은 [환경 준비](/ko/guide/environment-setup)를 참고하세요.

## 3. tapflow 설정 (선택)

`tapflow init`을 실행해 `tapflow.config.json`을 생성합니다. 터널을 묻고, 터널 없이 LAN으로 쓸 때는 스트리밍 성능(HTTP 또는 HTTPS)까지 대화형으로 물어봅니다. 기본값(포트 4000, 터널 없음, HTTP)으로 충분하다면 이 단계를 건너뛸 수 있습니다.

```sh
tapflow init
```

각 프롬프트가 무엇을 설정하는지, `.env` 자격 증명 파일과 CI 플래그는 어떻게 쓰는지는 [tapflow 설정](/ko/guide/configure)에서 다룹니다.

## 4. 릴레이 + 에이전트 시작

Mac에서 실행하세요:

```sh
tapflow start
# ✓ Relay started on ws://localhost:4000
# ✓ iOS Agent connected (3 simulators available)
```

::: tip 릴레이를 서버에 따로 띄우려면
`tapflow relay start`와 `tapflow agent start`를 사용하세요. 자세한 내용은 [릴레이 배포](/ko/guide/self-hosting)를 참고하세요.
:::

## 5. 관리자 계정 생성

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

## 6. 대시보드 열기

브라우저에서 `http://localhost:4000`에 접속한 뒤, 방금 생성한 계정으로 로그인합니다.

팀 초대 및 첫 번째 빌드 업로드까지 포함한 전체 온보딩 과정은 [최초 설정](/ko/dashboard/setup)을 참고하세요.

::: tip 환경 점검
설정 중 문제가 생기면 `tapflow doctor`를 실행하세요. Node.js 버전과 각 플랫폼에 필요한 도구들을 자동으로 진단합니다.
:::
