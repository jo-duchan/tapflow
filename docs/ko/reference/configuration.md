# 설정 파일

릴레이는 시작 디렉토리에서 `tapflow.config.json`을 읽습니다. 파일은 최초 실행 시 자동 생성됩니다. 설정을 변경한 뒤에는 릴레이를 재시작해야 적용됩니다.

## 예시

```json
{
  "server": {
    "port": 4000,
    "dataDir": ".tapflow-data"
  },
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "secure": false,
    "user": "relay@example.com",
    "pass": "password"
  }
}
```

`smtp.from`은 `smtp.user`가 설정되어 있으면 `tapflow <smtp.user>` 형태로 자동 설정됩니다. 발신자 주소를 다르게 지정하려면 명시적으로 입력합니다.

## 환경변수 오버라이드

환경변수는 항상 설정 파일보다 우선합니다. 서버 환경이나 CI에서 유용합니다.

| 환경변수 | Config 키 | 기본값 | 설명 |
|---------|-----------|--------|------|
| `TAPFLOW_PORT` | `server.port` | `4000` | 서버 포트 |
| `JWT_SECRET` | — | *(개발용 기본값)* | JWT 서명 키 (환경변수 전용) |
| `TAPFLOW_DATA_DIR` | `server.dataDir` | `.tapflow-data` | DB·업로드 디렉토리 (상대 경로 지원) |
| `SMTP_HOST` | `smtp.host` | `` | SMTP 호스트 |
| `SMTP_PORT` | `smtp.port` | `587` | SMTP 포트 |
| `SMTP_SECURE` | `smtp.secure` | `false` | TLS 사용 여부 (`true` 문자열로 설정) |
| `SMTP_USER` | `smtp.user` | `` | SMTP 사용자명 |
| `SMTP_PASS` | `smtp.pass` | `` | SMTP 비밀번호 |
| `SMTP_FROM` | `smtp.from` | `tapflow <smtp.user>` | 이메일 발신자 |

::: warning JWT_SECRET은 반드시 교체하세요
`JWT_SECRET`을 설정하지 않으면 개발용 기본값이 사용됩니다. 프로덕션에서 기본값을 사용하면 누구나 유효한 인증 토큰을 위조할 수 있습니다.

안전한 값을 생성하려면:

```sh
openssl rand -hex 32
```
:::

## 데이터 디렉토리

릴레이는 최초 실행 시 작업 디렉토리에 다음 파일들을 생성합니다:

```
your-directory/
  tapflow.config.json   ← 릴레이 설정 파일 (자동 생성)
  .tapflow-data/
    tapflow.db          ← SQLite 데이터베이스
    uploads/
      builds/           ← .app.zip 및 .apk 파일
      avatars/
      comments/
```

데이터 디렉토리 위치를 변경하려면 `TAPFLOW_DATA_DIR` 환경변수 또는 `server.dataDir`을 사용합니다. `.tapflow-data/`를 백업하면 모든 데이터가 보존됩니다.

## SMTP 설정

SMTP가 설정되지 않으면 초대 이메일과 비밀번호 재설정 이메일이 발송되지 않습니다. 이 경우 Admin이 초대 링크를 직접 복사해 공유할 수 있습니다.

팀 초대에 이메일을 사용하려면 `smtp.host`와 `smtp.user`, `smtp.pass`를 설정합니다.
