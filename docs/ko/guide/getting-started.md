# 빠른 시작

tapflow는 10분 안에 세팅부터 실행이 가능합니다.

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

## 2. 릴레이 + 에이전트 시작

Mac에서 실행합니다:

```sh
tapflow start
# ✓ Relay started on ws://localhost:4000
# ✓ iOS Agent connected (3 simulators available)
```

::: tip 릴레이를 서버에 따로 띄우려면
`tapflow relay start`와 `tapflow agent start`를 사용하세요. 자세한 내용은 [릴레이 서버 설정](/ko/guide/self-hosting)과 [셀프호스팅](/ko/guide/hosting)을 참고하세요.
:::

## 3. 관리자 계정 생성

tapflow는 기본 인증 정보가 없습니다. 최초 관리자 계정을 생성합니다:

```sh
tapflow init
  ? Admin email: admin@yourteam.com
  ? Password: ********
  ✓ Admin account created
  →  Open http://localhost:4000 to sign in
```

::: warning 최초 1회만 가능
`tapflow init`은 계정이 하나도 없을 때만 실행 가능합니다. 이후 팀원 추가는 대시보드 **Settings → Team**에서 초대로 진행합니다.
:::

## 4. 대시보드 열기

브라우저에서 `http://localhost:4000` (또는 릴레이 URL)으로 접속한 뒤, 방금 생성한 계정으로 로그인합니다.

팀 초대 및 첫 번째 빌드 업로드까지 포함한 전체 온보딩 과정은 [최초 설정](/ko/dashboard/setup)을 참고하세요.

::: tip 환경 점검
설정 중 문제가 생기면 `tapflow doctor`를 실행하세요. Node.js 버전, Xcode, adb 등 사전 요구사항을 자동으로 진단합니다.
:::
