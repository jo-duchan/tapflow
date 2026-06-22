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
| `tls` | LAN HTTPS(보안 컨텍스트) 설정. WebCodecs 하드웨어 디코드에 필요합니다. 아래 HTTPS 섹션을 참고하세요. |
| `smtp` | 초대·비밀번호 재설정 이메일 발송을 위한 SMTP 설정 |

`smtp.from`은 `smtp.user`가 설정되어 있으면 `tapflow <smtp.user>` 형태로 자동 설정됩니다. 발신자 주소를 다르게 지정하려면 명시적으로 입력합니다.

## 환경변수 오버라이드

환경변수는 항상 설정 파일보다 우선합니다. 서버 환경이나 CI에서 유용합니다.

비밀은 `.tapflow-data/.env` 파일에도 둘 수 있습니다. 릴레이가 시작할 때 이 파일을 먼저 읽으므로, 아래 변수를 셸 대신 파일에 적어도 됩니다. 우선순위는 **셸 환경변수 > `.env` > 설정 파일** 순입니다. 파일 형식과 예외(`TAPFLOW_DATA_DIR`)는 [tapflow 설정](/ko/guide/configure)에서 다룹니다.

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
| `TAPFLOW_CLOUDFLARE_TOKEN` | — | *(비어있음)* | `tls.dnsProvider`가 `cloudflare`일 때 DNS-01 발급에 쓰는 Cloudflare API 토큰. |
| `TAPFLOW_VERCEL_TOKEN` | — | *(비어있음)* | `tls.dnsProvider`가 `vercel`일 때 쓰는 Vercel API 토큰. |
| `TAPFLOW_VERCEL_TEAM_ID` | — | *(비어있음)* | 도메인이 팀 스코프에 속할 때 필요한 Vercel 팀 ID. |
| `TAPFLOW_ACME_EMAIL` | — | *(비어있음)* | Let's Encrypt 계정 연락 이메일(선택). |
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

생성한 값은 `.tapflow-data/.env`에 적거나 셸 환경변수로 주입합니다.
:::

::: warning 리버스 프록시 뒤에서는 TAPFLOW_TRUSTED_PROXIES를 설정하세요
릴레이를 같은 호스트의 리버스 프록시(nginx, Caddy) 뒤에서 운영하면서 `TAPFLOW_TRUSTED_PROXIES`를 비워 두면, 프록시의 loopback 주소 때문에 **모든 원격 클라이언트가 localhost로 취급**됩니다. localhost는 무인증이므로 외부에 그대로 노출됩니다. 프록시 주소(예: `127.0.0.1,::1`)를 `TAPFLOW_TRUSTED_PROXIES`에 설정하고, 프록시가 `X-Forwarded-For`를 전달하도록 구성하세요.

프록시나 터널로 노출하는 경우 공개 URL(`tunnel.publicUrl` 또는 `relay.url`)도 함께 설정하세요. 설정하지 않으면 CORS/CSRF 허용 목록이 loopback만 남아, 대시보드의 cross-origin 요청이 차단될 수 있습니다.
:::

## 스트리밍 튜닝 (에이전트)

아래 환경변수는 릴레이가 아니라 **에이전트** 프로세스(`tapflow agent start` / `tapflow start`)에 설정하며, 영상 스트림의 LAN 대역폭 ↔ 화질 트레이드오프를 조정합니다. 스트림을 *측정*하는 진단 플래그(`TAPFLOW_STREAM_METRICS`, `?perf=1` 패널)는 기여자용 도구로, [measurement.md](https://github.com/jo-duchan/tapflow/blob/main/contributing/measurement.md)를 참고하세요.

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `TAPFLOW_IOS_CODEC` | `h264` | iOS 스트림 코덱 — `h264`(기본) 또는 `jpeg`. H.264는 브라우저 지원도 필요하며, 미지원 브라우저는 자동으로 JPEG로 폴백합니다. |
| `TAPFLOW_IOS_H264_BITRATE` | `8000000` | iOS H.264 목표 비트레이트(bits/s, soft cap). 낮을수록 LAN 드롭은 줄고 모션 블록은 늘어납니다. |
| `TAPFLOW_JPEG_QUALITY` | `0.8` | iOS JPEG 품질(0–1), JPEG 경로 전용. 낮을수록 드롭은 줄고 아티팩트는 늘어납니다. |
| `TAPFLOW_MAX_SIZE` | *(원본)* | 긴 변 기준 다운스케일 상한(px), 양 플랫폼 공통. 낮을수록 대역폭·뷰어 디코드 부하는 줄고 화질은 낮아집니다. |
| `TAPFLOW_IOS_MAX_SIZE` / `TAPFLOW_ANDROID_MAX_SIZE` | *(원본)* | `TAPFLOW_MAX_SIZE`의 플랫폼별 오버라이드. |
| `TAPFLOW_ANDROID_FPS` | `30` | Android 에뮬레이터 캡처 프레임율(gRPC 경로). |
| `TAPFLOW_ANDROID_BACKEND` | *(자동)* | Android 백엔드 강제 — `grpc` 또는 `scrcpy`. 미설정 시 디바이스 종류로 자동 선택. |

## HTTPS (보안 컨텍스트)

브라우저의 하드웨어 가속 영상 디코드(WebCodecs)는 보안 컨텍스트(HTTPS)에서만 동작합니다. HTTP로 접속하면 소프트웨어 디코드로 자동 폴백합니다. 같은 LAN의 팀원에게 더 부드러운 화면을 주려면 relay를 HTTPS로 종단하세요. `tls`를 설정하면 relay가 같은 포트에서 HTTPS와 WSS를 함께 종단합니다.

발급 방식은 두 가지입니다.

### 자기 DNS 계정으로 자동 발급 (`byo-api-token`)

자기 도메인과 DNS 업체 API 토큰만 있으면 relay가 Let's Encrypt에서 DNS-01 방식으로 인증서를 자동 발급하고 갱신합니다.

```json
{
  "local": { "port": 4000 },
  "tls": {
    "mode": "byo-api-token",
    "domain": "tap.yourcompany.com",
    "dnsProvider": "cloudflare"
  }
}
```

| 키 | 설명 |
|----|------|
| `tls.mode` | `byo-api-token`(Let's Encrypt DNS-01 자동 발급) 또는 `import-cert`(직접 준비한 파일). |
| `tls.domain` | 인증서를 발급할 도메인. 팀원은 `https://[도메인]:[포트]`로 접속합니다. |
| `tls.dnsProvider` | `cloudflare` 또는 `vercel`. 해당 업체 API 토큰은 환경변수에서 읽습니다. |
| `tls.publishAddress` | 도메인 A 레코드를 이 머신의 LAN IP로 자동 발행합니다. 기본 `true`이며, DNS를 직접 관리하려면 `false`로 둡니다. |
| `tls.address` | 자동 감지한 LAN IP 대신 사용할 IP. 멀티 NIC나 VPN 환경에서 오버라이드용입니다. |

API 토큰은 설정 파일이 아니라 `tapflow init`이 만들어 두는 `.tapflow-data/.env` 파일에 적습니다. Cloudflare는 `TAPFLOW_CLOUDFLARE_TOKEN`, Vercel은 `TAPFLOW_VERCEL_TOKEN`을 씁니다. 팀 도메인이면 `TAPFLOW_VERCEL_TEAM_ID`도 함께 넣습니다. `.tapflow-data/`는 gitignore 대상이라 이 파일은 커밋되지 않습니다. 환경변수로 직접 설정한 값이 있으면 파일보다 우선합니다. 이 파일이 어떻게 만들어지고 읽히는지는 [tapflow 설정](/ko/guide/configure)에서 다룹니다.

`publishAddress`가 켜져 있으면 relay가 부팅할 때 자기 LAN IP를 도메인 A 레코드로 발행하고 주기적으로 갱신합니다. 팀원은 DNS를 건드리지 않고 도메인만 열면 됩니다.

### 직접 준비한 인증서 (`import-cert`)

사내 PKI나 이미 보유한 와일드카드 인증서를 쓰려면 파일 경로를 지정합니다. 갱신은 직접 관리합니다.

```json
{
  "tls": {
    "mode": "import-cert",
    "certPath": "/path/to/fullchain.pem",
    "keyPath": "/path/to/privkey.pem"
  }
}
```

| 키 | 설명 |
|----|------|
| `tls.certPath` | fullchain 인증서 PEM 경로. |
| `tls.keyPath` | 개인 키 PEM 경로. |

::: tip 접속과 알려진 제약
- 인증서는 도메인에 묶입니다. 따라서 `https://[도메인]:[포트]`로 접속해야 합니다. `localhost`나 IP로 접속하면 이름 불일치 경고가 납니다.
- 일부 공유기는 공개 도메인이 사설 IP를 가리키는 응답을 차단합니다(DNS rebinding). 이 경우 공유기에 예외를 등록하거나 로컬 DNS로 도메인을 LAN IP에 매핑하세요.
- WiFi 기기 격리(client isolation)가 켜진 망에서는 기기 간 통신이 막혀 LAN 접속 자체가 불가능합니다. 일반 가정·사무실 LAN을 사용하세요.
- 테스트로 스테이징 인증서(`TAPFLOW_ACME_STAGING=1`)를 발급하면 브라우저가 신뢰하지 않아 경고가 납니다. 같은 도메인을 스테이징에서 운영용으로 바꾼 직후에는 브라우저가 이전 인증서 오류를 캐시할 수 있습니다. 이때는 시크릿 창이나 기록 삭제로 다시 확인하세요.
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
