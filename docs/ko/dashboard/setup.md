# 최초 설정

새로운 릴레이에서 tapflow 대시보드를 처음 설정하는 과정을 안내합니다.

## 1. 릴레이 시작

Mac에서 실행합니다:

```sh
tapflow start
# ✓ Relay started on ws://localhost:4000
# ✓ iOS Agent connected (3 simulators available)
```

릴레이가 `http://localhost:4000`에서 실행됩니다.

## 2. 관리자 계정 생성

tapflow는 기본 인증 정보가 없습니다. 최초 관리자 계정을 생성합니다:

```sh
tapflow init
  ? Admin email: admin@yourteam.com
  ? Password: ********
  ✓ Admin account created
  →  Open http://localhost:4000 to sign in
```

::: tip 원격 릴레이인 경우
릴레이가 별도 서버에서 실행 중이라면 URL을 지정합니다:
```sh
tapflow init --relay https://your-relay-url
```
:::

::: warning 최초 1회만 가능
`tapflow init`은 계정이 하나도 없을 때만 실행 가능합니다. 이후 팀원 추가는 **Settings → Team**에서 초대로 진행합니다.
:::

## 3. 로그인

브라우저에서 `http://localhost:4000` (또는 릴레이 URL)으로 접속합니다. 방금 생성한 이메일과 비밀번호로 로그인합니다.

## 4. 팀원 초대

Admin으로 로그인한 뒤 **Settings → Team**에서 초대를 발송합니다:

1. **Invite member**를 클릭합니다.
2. 팀원의 이메일과 역할을 선택합니다:
   - **Admin** — 전체 접근 권한. 팀원 초대·삭제 가능.
   - **Developer** — 빌드 업로드 및 앱 관리 가능.
   - **QA** — 세션 시작 및 댓글 작성 가능.
   - **Viewer** — 빌드·녹화 읽기 전용.
3. **Send invite**를 클릭합니다. 팀원에게 비밀번호 설정 링크가 포함된 이메일이 발송됩니다.

::: tip SMTP 설정 전인 경우
SMTP가 설정되지 않았다면 응답에 포함된 초대 링크를 직접 복사해 공유하세요. SMTP 설정 방법은 [설정 파일](/ko/reference/configuration)을 참고하세요.
:::

## 5. 첫 번째 앱 추가

**App Center**로 이동합니다. 앱을 추가하는 두 가지 방법이 있습니다:

**방법 A — 빌드 업로드**: **Upload Build**를 클릭하고 파일을 선택합니다. tapflow가 bundle ID, 버전, 빌드 번호를 자동으로 읽어 App 항목을 생성합니다.

- iOS: `.app.zip` (`xcodebuild -sdk iphonesimulator`로 빌드한 `.app` 폴더를 압축)
- Android: `.apk`

**방법 B — 앱 수동 생성**: 사이드바에서 **+ Add App**을 클릭하고 앱 이름, bundle ID, 플랫폼을 입력합니다. 빌드가 준비되기 전에 앱을 먼저 등록할 때 사용합니다.

동일한 bundle ID의 다른 플랫폼 App이 이미 있으면 하나의 App으로 통합됩니다 (`both`).

## 6. 세션 시작

App Center에서 빌드를 선택하고 디바이스 카드를 클릭하면 세션이 시작됩니다. 디바이스 화면이 실시간으로 브라우저에 스트리밍됩니다.

---

**다음 단계:** 대시보드 각 섹션의 자세한 설명 → [대시보드 개요](/ko/dashboard/overview)
