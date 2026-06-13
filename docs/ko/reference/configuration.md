# 설정 파일

릴레이는 시작 디렉토리에서 `tapflow.config.json`을 읽습니다. `tapflow init`을 실행해 파일을 생성하고, 설정을 변경한 뒤에는 릴레이를 재시작해야 적용됩니다.

## 예시

```json
{
  "local": {
    "port": 4000,
    "dataDir": ".tapflow-data"
  },
  "relay": {
    "url": "https://your-relay-url"
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

| 키 | 설명 |
|----|------|
| `local` | 이 머신에서 실행하는 relay 서버 설정 |
| `relay.url` | 연결할 relay URL. `tapflow agent start`, `tapflow admin init`, `tapflow status`, `tapflow logs`의 기본값으로 사용됩니다. 설정 시 `--relay` 플래그 없이 동작합니다. 비어있으면 로컬 모드(`ws://localhost:[local.port]`)를 사용합니다. |
| `smtp` | 초대·비밀번호 재설정 이메일 발송을 위한 SMTP 설정 |

`smtp.from`은 `smtp.user`가 설정되어 있으면 `tapflow <smtp.user>` 형태로 자동 설정됩니다. 발신자 주소를 다르게 지정하려면 명시적으로 입력합니다.

## 환경변수 오버라이드

환경변수는 항상 설정 파일보다 우선합니다. 서버 환경이나 CI에서 유용합니다.

| 환경변수 | Config 키 | 기본값 | 설명 |
|---------|-----------|--------|------|
| `TAPFLOW_PORT` | `local.port` | `4000` | 서버 포트 |
| `JWT_SECRET` | — | *(자동 생성)* | JWT 서명 키 (환경변수 전용). 설정하지 않으면 최초 부팅 시 강력한 per-install 시크릿을 자동으로 생성해 데이터 디렉토리에 저장합니다. |
| `TAPFLOW_DATA_DIR` | `local.dataDir` | `.tapflow-data` | DB·업로드 디렉토리 (상대 경로 지원) |
| `TAPFLOW_RELAY_URL` | `relay.url` | *(비어있음)* | CLI 명령어의 기본 relay URL |
| `TAPFLOW_AGENT_TOKEN` | — | *(비어있음)* | 원격 릴레이 인증용 `agent` 스코프 토큰. `--token` 플래그가 우선합니다. [에이전트 설정](/ko/guide/agent#원격-릴레이-인증)을 참고하세요. |
| `TAPFLOW_TRUSTED_PROXIES` | — | *(비어있음)* | 신뢰하는 리버스 프록시 IP 목록(콤마 구분, 예: `127.0.0.1,::1`). 릴레이를 같은 호스트의 리버스 프록시 뒤에서 실행할 때 이 값을 설정하면, 프록시 주소 대신 `X-Forwarded-For`에 담긴 실제 클라이언트 IP를 사용합니다. 비어 있으면 전달 헤더를 파싱하지 않습니다. |
| `TAPFLOW_BUILD_TTL_DAYS` | — | `7` | Done 빌드 파일·레코드 자동 삭제 기간(일). 로컬 테스트 시 `0.001` 등 작은 값으로 즉시 확인 가능. |
| `TAPFLOW_WS_BACKPRESSURE_BYTES` | — | `1048576` (1 MB) | 브라우저 소켓당 바이너리 프레임 드롭 임계값. 버퍼가 이 값을 초과하면 프레임이 드롭됩니다. |
| `SMTP_HOST` | `smtp.host` | `` | SMTP 호스트 |
| `SMTP_PORT` | `smtp.port` | `587` | SMTP 포트 |
| `SMTP_SECURE` | `smtp.secure` | `false` | TLS 사용 여부 (`true` 문자열로 설정) |
| `SMTP_USER` | `smtp.user` | `` | SMTP 사용자명 |
| `SMTP_PASS` | `smtp.pass` | `` | SMTP 비밀번호 |
| `SMTP_FROM` | `smtp.from` | `tapflow <smtp.user>` | 이메일 발신자 |

::: tip JWT_SECRET은 선택 사항입니다
단일 릴레이라면 `JWT_SECRET`을 따로 설정하지 않아도 됩니다. 설정하지 않으면 릴레이가 최초 부팅 시 강력한 per-install 시크릿을 생성해 데이터 디렉토리(`jwt-secret`, 소유자 전용 권한)에 저장합니다.

고정 키가 필요한 경우, 예를 들어 여러 릴레이 인스턴스가 하나의 시크릿을 공유해야 한다면 `JWT_SECRET`을 명시적으로 설정하세요:

```sh
openssl rand -hex 32
```
:::

::: warning 리버스 프록시 뒤에서는 TAPFLOW_TRUSTED_PROXIES를 설정하세요
릴레이를 같은 호스트의 리버스 프록시(nginx, Caddy) 뒤에서 운영하면서 `TAPFLOW_TRUSTED_PROXIES`를 비워 두면, 프록시의 loopback 주소 때문에 **모든 원격 클라이언트가 localhost로 취급**됩니다. localhost는 무인증이므로 외부에 그대로 노출됩니다. 프록시 주소(예: `127.0.0.1,::1`)를 `TAPFLOW_TRUSTED_PROXIES`에 설정하고, 프록시가 `X-Forwarded-For`를 전달하도록 구성하세요.

프록시나 터널로 노출하는 경우 공개 URL(`tunnel.publicUrl` 또는 `relay.url`)도 함께 설정하세요. 설정하지 않으면 CORS/CSRF 허용 목록이 loopback만 남아, 대시보드의 cross-origin 요청이 차단될 수 있습니다.
:::

## 데이터 디렉토리

릴레이는 최초 실행 시 작업 디렉토리에 다음 파일들을 생성합니다:

```text
your-directory/
  tapflow.config.json   ← 릴레이 설정 파일 (tapflow init으로 생성)
  .tapflow-data/
    tapflow.db          ← SQLite 데이터베이스
    uploads/
      builds/           ← .app.zip 및 .apk 파일
      avatars/
      comments/
```

데이터 디렉토리 위치를 변경하려면 `TAPFLOW_DATA_DIR` 환경변수 또는 `local.dataDir`을 사용합니다. `.tapflow-data/`를 백업하면 모든 데이터가 보존됩니다.

## SMTP 설정

SMTP가 설정되지 않으면 초대 이메일과 비밀번호 재설정 이메일이 발송되지 않습니다. 이 경우 Admin이 초대 링크를 직접 복사해 공유할 수 있습니다.

팀 초대에 이메일을 사용하려면 `smtp.host`와 `smtp.user`, `smtp.pass`를 설정합니다.
