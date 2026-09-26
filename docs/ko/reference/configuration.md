# 설정 파일

릴레이는 이 머신의 설치 디렉터리에서 `tapflow.config.json`을 읽습니다. 기본값은 `~/.tapflow`이고, `TAPFLOW_HOME`이나 현재 디렉터리의 기존 설치가 있으면 그쪽입니다([명령이 쓰는 설치 디렉터리](/ko/operate/configure#명령이-쓰는-설치-디렉토리)). `tapflow init`을 실행해 파일을 생성하고, 설정을 변경한 뒤에는 릴레이를 재시작해야 적용됩니다.

파일 안의 상대 경로는 그 파일을 기준으로 풉니다. `tsconfig.json`이나 `litestream.yml`과 같은 방식입니다. `~/.tapflow/tapflow.config.json`의 `"dataDir": "data"`는 어느 디렉터리에서 명령을 실행하든 `~/.tapflow/data`를 뜻합니다.

## 예시

```json
{
  "local": {
    "port": 4000,
    "dataDir": "data"
  },
  "relay": {
    "url": "wss://your-relay-url"
  },
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "secure": false,
    "user": "relay@example.com",
    "pass": "password"
  },
  "webhooks": [
    { "url": "https://ci.internal/hooks/tapflow", "secretEnv": "TAPFLOW_WEBHOOK_SECRET_CI" }
  ]
}
```

| 키 | 설명 |
|----|------|
| `local` | 이 머신에서 실행하는 릴레이 서버 설정 |
| `relay.url` | 연결할 릴레이 URL. `tapflow agent start`, `tapflow admin init`, `tapflow status`, `tapflow logs`의 기본값으로 사용됩니다. 설정 시 `--relay` 플래그 없이 동작합니다. 비어있으면 로컬 모드(`ws://localhost:[local.port]`)를 사용합니다. `ws://` 또는 `wss://`로 적어야 합니다. `tapflow agent start`는 다른 스킴을 거부하고 나머지 명령은 필요하면 HTTP 스킴으로 바꿔 씁니다. |
| `tunnel` | `tapflow start`와 `tapflow relay start`가 함께 띄우는 터널 설정. 아래 터널 섹션을 참고하세요. |
| `tls` | LAN HTTPS(보안 컨텍스트) 설정. WebCodecs 하드웨어 디코드에 필요합니다. 아래 HTTPS 섹션을 참고하세요. |
| `smtp` | 초대·비밀번호 재설정 이메일 발송을 위한 SMTP 설정 |
| `webhooks` | 빌드 리뷰 상태가 바뀔 때 알림을 보낼 아웃바운드 엔드포인트. 서명 secret은 `secretEnv`가 가리키는 환경 변수에서 읽습니다. 아래 웹훅 섹션을 참고하세요. |
| `agent.lean` | Lean mode 설정. 이 머신의 에이전트가 부팅하는 iOS 시뮬레이터와 Android 에뮬레이터에 적용됩니다. 릴레이가 아니라 에이전트가 읽는 값입니다. 기본값은 `false`입니다. 아래 Lean mode 섹션을 참고하세요. |

`smtp.from`은 `smtp.user`가 설정되어 있으면 `tapflow <smtp.user>` 형태로 자동 설정되고 없으면 `tapflow <noreply@tapflow.local>`입니다. 발신자 주소를 다르게 지정하려면 명시적으로 입력합니다.

## 환경변수 오버라이드

환경변수는 항상 설정 파일보다 우선합니다. 서버 환경이나 CI에서 유용합니다.

비밀은 데이터 디렉터리의 `.env` 파일에도 둘 수 있습니다. 릴레이가 시작할 때 이 파일을 먼저 읽으므로, 아래 변수를 셸 대신 파일에 적어도 됩니다. 우선순위는 **셸 환경변수 > `.env` > 설정 파일** 순입니다. 파일 형식과 예외(`TAPFLOW_DATA_DIR`)는 [tapflow 설정](/ko/operate/configure)에서 다룹니다.

| 환경변수 | Config 키 | 기본값 | 설명 |
|---------|-----------|--------|------|
| `TAPFLOW_PORT` | `local.port` | `4000` | 서버 포트 |
| `TAPFLOW_TUNNEL_PORT` | `local.tunnelPort` | 터널 설정이 있으면 `4001`, 없으면 꺼짐 | rathole, `tailscale serve`, `cloudflared` 같은 터널 클라이언트가 연결하는 loopback 전용 포트. 릴레이 머신 안에서 온 연결이라도 이 포트로 들어오면 원격으로 보므로, 로그인하거나 토큰을 내야 합니다. `tapflow start`와 `tapflow relay start`는 `tunnel` 설정이 있으면 이 포트를 엽니다. Docker 이미지를 포함한 그 밖의 경우에는 이 변수나 `local.tunnelPort`로 포트를 지정해야 열립니다. 릴레이와 같은 네트워크 네임스페이스에서 연결하는 터널이나 프록시가 있다면 설정하세요. 릴레이가 `4001`을 쓰면 기본값은 `4002`로 바뀝니다. 컨테이너 안에서는 릴레이와 네트워크 네임스페이스를 공유하는 프로세스만 연결할 수 있습니다. |
| `JWT_SECRET` | — | *(자동 생성)* | JWT 서명 키 (환경변수 전용). 설정하지 않으면 최초 부팅 시 강력한 per-install 시크릿을 자동으로 생성해 데이터 디렉터리에 저장합니다. 직접 설정할 때는 32자 이상이어야 하며 짧으면 릴레이가 시작하지 않습니다. |
| `TAPFLOW_HOME` | — | `~/.tapflow` | 설치 디렉터리. `tapflow.config.json`과 기본 데이터 디렉터리가 있는 곳이고 모든 명령이 이 값을 읽습니다. 상대 경로는 현재 디렉터리 기준이고 빈 값은 미설정으로 봅니다. 없는 디렉터리를 가리키면 릴레이를 실행하거나 릴레이에 접속하는 명령이 멈춥니다. `tapflow init`은 대신 그 디렉터리를 만듭니다. |
| `TAPFLOW_DATA_DIR` | `local.dataDir` | `<설치>/data` | DB·업로드 디렉터리. 환경변수는 현재 디렉터리 기준, `local.dataDir`은 설정 파일 기준으로 상대 경로를 풉니다. 이미 `.tapflow/data`나 `.tapflow-data`가 있는 설치는 그대로 씁니다. |
| `TAPFLOW_RELAY_URL` | `relay.url` | *(비어있음)* | CLI 명령어의 기본 릴레이 URL |
| `TAPFLOW_AGENT_TOKEN` | — | *(비어있음)* | 원격 릴레이 인증용 `agent` 스코프 토큰. `--token` 플래그가 우선합니다. [에이전트 설정](/ko/operate/agents#원격-릴레이-인증)을 참고하세요. |
| `TAPFLOW_TOKEN` | — | *(비어있음)* | `tapflow flow run`과 MCP 서버가 원격 릴레이에 접속할 때 쓰는 개인 액세스 토큰(PAT). `flow run`에서는 `--token` 플래그가 우선합니다. |
| `TAPFLOW_TUNNEL_TOKEN` | — | *(비어있음)* | rathole 터널 인증에 쓰는 비밀 문자열. `tunnel.provider`가 `rathole`일 때 필요합니다. |
| `TAPFLOW_LEAN` | `agent.lean` | `off` | `on` 또는 `off`. 다른 값은 경고와 함께 무시하고 설정 파일의 값을 씁니다. |
| `TAPFLOW_TRUSTED_PROXIES` | — | *(비어있음)* | 신뢰하는 리버스 프록시 IP 목록(콤마 구분, 예: `127.0.0.1,::1`). 릴레이를 같은 호스트의 리버스 프록시 뒤에서 실행할 때 이 값을 설정하면, 프록시 주소 대신 `X-Forwarded-For`에 담긴 실제 클라이언트 IP를 사용합니다. 비어 있으면 전달 헤더를 파싱하지 않습니다. |
| `TAPFLOW_BUILD_TTL_DAYS` | — | `7` | 삭제를 예약한 빌드의 파일·레코드를 실제로 지우기까지 보관하는 기간(일). 예약은 수동 동작이라 **Done** 표시만으로는 삭제되지 않는다. 로컬 테스트 시 `0.001` 등 작은 값으로 즉시 확인 가능. |
| `TAPFLOW_MAX_BUILD_BYTES` | — | `524288000` (500 MB) | 빌드 업로드 크기 상한(바이트). |
| `TAPFLOW_MAX_UNPACKED_BYTES` | — | 업로드 상한의 4배 | iOS `.tar.gz` 빌드를 풀었을 때의 크기 상한(바이트). |
| `TAPFLOW_MAX_COMMENT_BYTES` | — | `5242880` (5 MB) | 댓글 첨부 이미지 크기 상한(바이트). |
| `IDLE_TIMEOUT_MS` | — | `300000` (5분) | 브라우저가 세션을 떠난 뒤 세션을 종료하기까지 기다리는 시간(밀리초). |
| `TAPFLOW_RESOURCE_THRESHOLD_PERCENT` | — | `80` | 에이전트 Mac의 CPU나 메모리 사용률이 이 값(%)을 넘으면 새 세션 참여를 거절합니다. |
| `TAPFLOW_WS_BACKPRESSURE_BYTES` | — | `1048576` (1 MB) | 브라우저 소켓당 바이너리 프레임 드롭 임계값. 버퍼가 이 값을 초과하면 프레임이 드롭됩니다. |
| `TAPFLOW_AGENT_GRACE_MS` | — | `15000` (15초) | 에이전트 연결이 끊긴 뒤 그 에이전트가 돌아오기를 기다리며 세션을 유지하는 시간(밀리초). 에이전트는 프로세스 시작 후 약 1초면 등록되므로 기본값은 재시작을 넉넉히 덮습니다. 이 동안 열린 탭은 멈춘 화면 대신 기다리는 중임을 표시하고, 해당 기기는 다른 사람에게 제공되지 않습니다. `0`은 유지를 끄며, 에이전트 소켓이 닫히는 즉시 세션이 종료됩니다(이 기능이 생기기 전 동작). 빈 값·숫자가 아닌 값·음수는 기본값으로 되돌아가고 시작 시 경고를 남깁니다. |
| `TAPFLOW_CLOUDFLARE_TOKEN` | — | *(비어있음)* | `tls.dnsProvider`가 `cloudflare`일 때 DNS-01 발급에 쓰는 Cloudflare API 토큰. |
| `TAPFLOW_VERCEL_TOKEN` | — | *(비어있음)* | `tls.dnsProvider`가 `vercel`일 때 쓰는 Vercel API 토큰. |
| `TAPFLOW_VERCEL_TEAM_ID` | — | *(비어있음)* | 도메인이 팀 스코프에 속할 때 필요한 Vercel 팀 ID. |
| `TAPFLOW_ACME_EMAIL` | — | *(비어있음)* | Let's Encrypt 계정 연락 이메일(선택). |
| `TAPFLOW_ACME_STAGING` | — | *(비어있음)* | `1`이면 Let's Encrypt 스테이징 환경에서 발급합니다. 테스트용이며 브라우저가 신뢰하지 않는 인증서가 나옵니다. |
| `TAPFLOW_ADMIN_EMAIL` | — | *(비어있음)* | 릴레이가 부팅하면서 만드는 첫 Admin 계정의 이메일. `TAPFLOW_ADMIN_PASSWORD`와 **함께** 설정합니다. 이미 소유자가 있는 설치에서는 아무 일도 하지 않습니다. |
| `TAPFLOW_ADMIN_PASSWORD` | — | *(비어있음)* | 그 계정의 비밀번호. 최소 8자입니다. |
| `SMTP_HOST` | `smtp.host` | `` | SMTP 호스트 |
| `SMTP_PORT` | `smtp.port` | `587` | SMTP 포트 |
| `SMTP_SECURE` | `smtp.secure` | `false` | TLS 사용 여부 (`true` 문자열로 설정) |
| `SMTP_USER` | `smtp.user` | `` | SMTP 사용자명 |
| `SMTP_PASS` | `smtp.pass` | `` | SMTP 비밀번호 |
| `SMTP_FROM` | `smtp.from` | `tapflow <smtp.user>` (`smtp.user`가 없으면 `tapflow <noreply@tapflow.local>`) | 이메일 발신자 |
| `LOG_LEVEL` | — | `info` | 로그 수준. `debug`, `info`, `warn`, `error` 중 하나입니다. 릴레이와 에이전트 모두 읽습니다. |

::: tip JWT_SECRET은 선택 사항입니다
단일 릴레이라면 `JWT_SECRET`을 따로 설정하지 않아도 됩니다. 설정하지 않으면 릴레이가 최초 부팅 시 강력한 per-install 시크릿을 생성해 데이터 디렉터리(`jwt-secret`, 소유자 전용 권한)에 저장합니다.

고정 키가 필요한 경우, 예를 들어 여러 릴레이 인스턴스가 하나의 시크릿을 공유해야 한다면 `JWT_SECRET`을 명시적으로 설정하세요:

```sh
openssl rand -hex 32
```

생성한 값은 데이터 디렉터리의 `.env`(기본값 `~/.tapflow/data/.env`)에 적거나 셸 환경변수로 주입합니다. 32자보다 짧은 값은 거부됩니다.
:::

::: warning 같은 호스트의 프록시와 터널은 터널 포트로 연결하세요
릴레이는 loopback으로 들어온 연결에 로그인을 요구하지 않습니다. 리버스 프록시(nginx, Caddy), `cloudflared`, `tailscale serve`를 릴레이 옆에서 실행하면 바로 이 경로로 연결합니다. 네이티브 설치라면 같은 머신이고, 컨테이너라면 릴레이와 같은 네트워크 네임스페이스입니다. 이때 릴레이 포트로 연결하면 **전달하는 모든 클라이언트가 로컬로 보입니다**. 대신 터널 포트(`127.0.0.1:4001`, `TAPFLOW_TUNNEL_PORT` 참고)로 연결하세요. 이 포트의 연결은 모두 원격으로 봅니다. 다른 호스트의 프록시는 이미 원격으로 취급되므로 바꿀 것이 없고, Docker 브리지를 거쳐 컨테이너에 닿는 프록시도 마찬가지입니다.

실제 클라이언트 주소로 로그를 남기고 요청 제한을 적용하려면 `TAPFLOW_TRUSTED_PROXIES`에 프록시 주소(예: `127.0.0.1,::1`)도 설정하고 프록시가 `X-Forwarded-For`를 전달하도록 구성하세요. 릴레이 포트에 그대로 연결하는 프록시라면 이 설정이 있어야 클라이언트를 원격으로 봅니다. rathole처럼 TCP를 그대로 넘기는 터널은 헤더를 붙이지 않으므로 터널 포트를 써야 합니다.

프록시나 터널로 노출하는 경우 공개 URL(`tunnel.publicUrl` 또는 `relay.url`)도 함께 설정하세요. 설정하지 않으면 CORS/CSRF 허용 목록이 loopback만 남아, 대시보드의 cross-origin 요청이 차단될 수 있습니다.
:::

<a name="docker-컨테이너에서-첫-관리자-계정-만들기-tapflow-admin-email"></a>

## Docker 컨테이너에서 첫 관리자 계정 만들기 (`TAPFLOW_ADMIN_EMAIL`) {#create-the-first-admin-account-in-a-docker-container-tapflow-admin-email}

두 변수를 설정하면 릴레이가 시작하면서 첫 Admin 계정을 만듭니다. 브라우저 온보딩과 `tapflow admin init`이 모두 닿지 않는 Docker 설치를 위한 경로입니다.

평소에는 브라우저에서 `/setup` 페이지로 첫 계정을 만듭니다. 브라우저를 쓸 수 없는 서버에서는 `tapflow admin init`이 그 자리를 대신합니다. 컨테이너에서는 둘 다 막힙니다. `/setup`은 루프백에서 온 요청에만 응답하는데 컨테이너는 브리지 게이트웨이를 거쳐서 그 검사에 걸립니다. 그리고 릴레이 전용 이미지에는 CLI가 들어 있지 않습니다.

동작은 이렇습니다.

- **이미 소유자가 있으면 아무 일도 하지 않습니다.** 계정이 덮어써지지 않고 재시작할 때마다 반복되지도 않습니다. 아래 세 가지도 이때는 검사하지 않습니다.
- 소유자가 없는 설치에서는 두 변수를 함께 설정해야 합니다. 하나만 있으면 릴레이가 시작하지 않습니다.
- 비밀번호는 8자 이상이어야 합니다. 짧으면 역시 시작하지 않습니다.
- 요청한 계정이 만들어지지 않으면 릴레이가 시작하지 않습니다. 소유자 없는 릴레이는 루프백에 닿는 무엇이든 차지할 수 있어서 그대로 서비스하는 것보다 멈추는 편이 안전합니다.

두 변수를 비워두면 아무것도 달라지지 않습니다.

값을 둘 자리는 두 곳이고 **둘을 섞으면 안 됩니다.** 컴포즈는 보간할 값을 셸이나 컴포즈 파일 옆의 `.env`에서 찾습니다. 릴레이는 볼륨 안의 `.tapflow/data/.env`를 읽습니다. 서로 다른 파일입니다.

### 컴포즈에 두는 경우

```yaml
services:
  relay:
    image: tapflow/tapflow:latest
    environment:
      - TAPFLOW_ADMIN_EMAIL=admin@yourteam.com
      - TAPFLOW_ADMIN_PASSWORD=${TAPFLOW_ADMIN_PASSWORD:?set this before starting}
```

`${...:?}`는 값이 없으면 컴포즈가 시작을 거부하는 문법입니다. 리터럴을 적어두면 그대로 복사돼 알려진 비밀번호가 됩니다. 값은 셸 환경변수로 넣거나 컴포즈 파일 옆의 `.env`에 적습니다.

### 릴레이의 `.env`에 두는 경우

`environment:`에서 두 줄을 빼고 이미 마운트하고 있는 볼륨 안에 적습니다. 비밀번호가 컴포즈 파일과 셸 히스토리 양쪽에서 빠집니다.

```ini
# 비밀번호는 = 뒤에 직접 적습니다. 비워 두면 릴레이가 시작하지 않습니다.
TAPFLOW_ADMIN_EMAIL=admin@yourteam.com
TAPFLOW_ADMIN_PASSWORD=
```

직접 만든 파일은 권한을 좁혀 주세요.

```sh
chmod 600 .tapflow/data/.env
```

`tapflow init`은 이 파일을 0600으로 만들지만 릴레이 전용 이미지에는 CLI가 없어서 컨테이너 운영자는 자기 umask로 직접 파일을 만들게 됩니다. 릴레이는 시작할 때 모드를 확인하고 다른 사용자가 읽을 수 있으면 경고합니다.

```text
.tapflow/data/.env is readable by other users (mode 644). Run: chmod 600 .tapflow/data/.env
```

경고일 뿐 시작을 막지는 않습니다.

## 스트리밍 튜닝 (에이전트)

아래 환경변수는 릴레이가 아니라 **에이전트** 프로세스(`tapflow agent start` / `tapflow start`)에 설정하며, 영상 스트림의 LAN 대역폭 ↔ 화질 트레이드오프를 조정합니다. 스트림을 *측정*하는 진단 플래그(`TAPFLOW_STREAM_METRICS`, `?perf=1` 패널)는 기여자용 도구로, [measurement.md](https://github.com/jo-duchan/tapflow/blob/main/contributing/measurement.md)를 참고하세요.

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `TAPFLOW_IOS_CODEC` | `h264` | iOS 스트림 코덱 — `h264`(기본) 또는 `jpeg`. H.264는 브라우저 지원도 필요하며, 미지원 브라우저는 자동으로 JPEG로 폴백합니다. |
| `TAPFLOW_IOS_H264_BITRATE` | `8000000` | iOS H.264 목표 비트레이트(bits/s, soft cap). 낮을수록 LAN 드롭은 줄고 모션 블록은 늘어납니다. |
| `TAPFLOW_JPEG_QUALITY` | `0.8` | iOS JPEG 품질(0–1), JPEG 경로 전용. 낮을수록 드롭은 줄고 아티팩트는 늘어납니다. |
| `TAPFLOW_MAX_SIZE` | *(연결 방식별)* | 긴 변 기준 다운스케일 상한(px), 양 플랫폼 공통. 낮을수록 대역폭·뷰어 디코드 부하는 줄고 화질은 낮아집니다. 설정하지 않으면 뷰어의 연결 방식으로 정합니다. localhost와 LAN HTTPS는 원본, LAN HTTP는 `TAPFLOW_MAX_SIZE_LAN`, 외부 연결은 `TAPFLOW_MAX_SIZE_EXTERNAL`을 따릅니다. `0`이면 모든 연결에서 원본입니다. |
| `TAPFLOW_MAX_SIZE_LAN` | `1280` | `TAPFLOW_MAX_SIZE`가 없을 때 LAN HTTP 연결에 쓰는 상한(px). |
| `TAPFLOW_MAX_SIZE_EXTERNAL` | `1000` | `TAPFLOW_MAX_SIZE`가 없을 때 외부 연결에 쓰는 상한(px). |
| `TAPFLOW_IOS_MAX_SIZE` / `TAPFLOW_ANDROID_MAX_SIZE` | *(연결 방식별)* | `TAPFLOW_MAX_SIZE`의 플랫폼별 오버라이드. |
| `TAPFLOW_ANDROID_FPS` | `30` | Android 에뮬레이터 캡처 프레임율(gRPC 경로). |
| `TAPFLOW_ANDROID_BACKEND` | *(자동)* | Android 백엔드 강제 — `grpc` 또는 `scrcpy`. 미설정 시 기기 종류로 자동 선택. |
| `TAPFLOW_ANDROID_GRPC_PORT` | `8554` | tapflow가 부팅하는 에뮬레이터에 gRPC 포트를 고를 때 시작하는 포트. 이 값부터 2씩 올려 가며 비어 있는 첫 포트를 씁니다. |
| `TAPFLOW_AUDIO` | *(켜짐)* | `off`이면 기기 오디오 스트리밍을 끕니다. [오디오](/ko/testing/audio)를 참고하세요. |
| `TAPFLOW_ALLOW_DISPLAY_SLEEP` | *(비어있음)* | 값을 설정하면 세션 중에도 호스트 디스플레이가 꺼질 수 있습니다. 시스템 절전은 계속 막습니다. [에이전트 설정](/ko/operate/agents#호스트-디스플레이와-절전)을 참고하세요. |

## Lean mode (에이전트)

`agent.lean`을 `true`로 두면, 에이전트는 부팅하는 모든 iOS 시뮬레이터에서 정해진 목록의 백그라운드 서비스를 끄고 Android 에뮬레이터에서는 번들 앱 몇 개를 비활성화합니다(아래 참고). iOS 27에서 재 보면 시뮬레이터 한 대의 메모리가 4분의 1 정도, 약 0.5GB 줄어듭니다. 그만큼 Mac 한 대가 스왑 없이 띄울 수 있는 시뮬레이터가 늘어납니다.

```json
{ "agent": { "lean": true } }
```

**꺼지는 것:** Siri와 Apple Intelligence의 백그라운드 작업, iCloud 키체인과 백업, 건강 앱·피트니스·HomeKit, 사진 분석, 가족 공유와 스크린 타임, 뉴스·지도 동기화·팁, iMessage와 FaceTime, AirDrop·Continuity·CarPlay·Watch·나의 찾기, Safari 북마크 동기화, 텔레메트리.

**켜 두는 것:** 앱이 흔히 기대는 서비스와 테스터가 화면에서 보는 것은 켜 둡니다. 배경화면과 위젯, 받아쓰기·음성·키보드 추천, Apple로 로그인, CloudKit과 iCloud Drive, StoreKit·푸시·지갑, HealthKit, 사진 선택기, 연락처와 캘린더, Spotlight와 설정 검색, 유니버설 링크, WeatherKit, MapKit, Game Center, CallKit이 여기에 해당합니다. 목록은 앱에 맞춰 고르는 게 아니라 정해져 있으므로, 테스트하는 앱이 위의 꺼지는 목록에 든 서비스를 쓴다면 Lean mode를 사용하지 마세요. 스트리밍, 입력, UI 트리, 클립보드, 오디오, 설치, 딥링크, 네트워크 제어 같은 tapflow 자체 기능은 lean 시뮬레이터에서 확인했습니다.

tapflow가 시뮬레이터를 실행하는 동안에만 적용됩니다.

- 에이전트는 꺼져 있는 시뮬레이터를 부팅하기 직전에 설정을 쓰고 시뮬레이터를 종료할 때 되돌립니다. 그 뒤에 Xcode나 Simulator.app에서 같은 시뮬레이터를 부팅하면 모든 서비스가 켜진 원래 상태로 뜹니다.
- 세션이 요청했을 때 이미 실행 중인 시뮬레이터는 그대로 씁니다. 다음에 tapflow로 부팅할 때부터 적용됩니다.
- 에이전트가 시뮬레이터를 종료하지 못하고 멈췄다면 그 시뮬레이터는 켜져 있는 동안 누가 열든 lean 상태입니다. 시뮬레이터가 꺼진 뒤 다음에 접속하는 에이전트가 설정을 되돌립니다.
- `tapflow boot`는 에이전트를 거치지 않고 시뮬레이터를 켜므로 지금 저장된 설정 그대로 부팅합니다. 비정상 종료로 남은 Lean 설정을 에이전트가 아직 되돌리지 않았다면 lean 상태로 뜹니다.

iOS 18.5 이상 런타임에서만 동작하고 그 밖의 런타임과 tvOS·watchOS 시뮬레이터는 건드리지 않습니다. `tapflow doctor ios`는 Lean mode가 켜져 있는지와 지금 lean 상태인 시뮬레이터가 몇 대인지 보여 줍니다.

### Android 에뮬레이터

Android에서는 에이전트가 Google 번들 앱 네 개를 비활성화합니다. Google 앱, YouTube, YouTube Music, 디지털 웰빙이며 모두 부팅할 때 스스로 뜨는 앱입니다. API 34 에뮬레이터에서 재 보면 게스트가 Mac 메모리를 약 350MB, 5분의 1이 조금 안 되게 덜 씁니다.

에뮬레이터는 종료할 때만 Mac에 메모리를 돌려주므로, 앱은 부팅 전에 이미 꺼져 있어야 절감이 생깁니다. 그래서 iOS와 방식이 다릅니다. Lean mode가 켜져 있는 동안 앱을 계속 비활성화해 둡니다. 절감은 tapflow로 두 번째 부팅할 때부터 나타납니다.

- 홈 화면에서 Google 검색창과 어시스턴트가 사라집니다. `ACTION_WEB_SEARCH`를 보내는 앱은 처리할 앱을 찾지 못합니다. 음성 입력은 다른 앱이 처리하므로 그대로 동작합니다.
- 포토·메시지·Gmail·지도는 켜 둡니다. 앱이 이미지·문자·메일·지도를 이 앱들로 엽니다.
- 세션이 요청했을 때 이미 실행 중인 에뮬레이터는 다음에 tapflow로 부팅할 때부터 lean이 적용됩니다.
- 앱은 에뮬레이터 안에서 비활성화되므로 Android Studio에서 열어도 꺼져 있습니다. Lean mode가 켜져 있는 동안 직접 다시 켠 앱은 다음에 tapflow가 그 에뮬레이터를 부팅할 때 다시 꺼집니다.
- Lean mode를 끄면 다음에 tapflow가 그 에뮬레이터를 부팅할 때 앱이 돌아옵니다. tapflow 없이 되돌리려면 앱마다 `adb shell pm enable <패키지>`를 실행한 뒤 `adb shell rm /data/local/tmp/tapflow-lean.json`을 실행하세요.
- `tapflow doctor android`는 Lean mode가 켜져 있는지 보여 줍니다. 어떤 에뮬레이터가 lean 상태인지는 각 에뮬레이터 안에 기록되므로 doctor가 셀 수 없습니다.

Mac 여러 대로 구성했다면, 각 Mac의 `tapflow.config.json`이 그 Mac의 에이전트에 적용됩니다.

## 터널

`tunnel`을 설정하면 `tapflow start`와 `tapflow relay start`가 릴레이와 함께 터널을 띄웁니다. 지원하는 `provider`는 `tailscale`과 `rathole`입니다. 설정 예시는 [`tapflow relay start`](/ko/reference/cli#tapflow-relay-start)에 있고 전체 절차는 [외부 접속](/ko/operate/external-access)에서 다룹니다.

| 키 | 설명 |
|----|------|
| `tunnel.provider` | `tailscale` 또는 `rathole` (필수) |
| `tunnel.publicUrl` | 팀원이 접속할 공개 URL. rathole에서는 필수입니다. Tailscale에서는 생략하면 MagicDNS 호스트명으로 정합니다. |
| `tunnel.serverAddr` | rathole 서버 주소(`host:port`). rathole 전용이며 필수입니다. |
| `tunnel.ssh.host` / `tunnel.ssh.user` | rathole 서버를 SSH로 관리할 때 접속할 호스트와 사용자. `ssh`를 생략하면 서버가 이미 실행 중이라고 봅니다. |
| `tunnel.ssh.keyPath` | SSH 개인 키 경로(선택). |

rathole을 쓰려면 `TAPFLOW_TUNNEL_TOKEN` 환경변수도 설정해야 합니다.

<a id="https-보안-컨텍스트"></a>

## HTTPS (보안 컨텍스트) {#https-secure-context}

브라우저의 하드웨어 가속 영상 디코드(WebCodecs)는 보안 컨텍스트(HTTPS)에서만 동작합니다. HTTP로 접속하면 소프트웨어 디코드로 자동 폴백합니다. 같은 LAN의 팀원에게 더 부드러운 화면을 주려면 릴레이를 HTTPS로 종단하세요. `tls`를 설정하면 릴레이가 같은 포트에서 HTTPS와 WSS를 함께 종단합니다.

발급 방식은 두 가지입니다.

### 자기 DNS 계정으로 자동 발급 (`byo-api-token`)

자기 도메인과 DNS 업체 API 토큰만 있으면 릴레이가 Let's Encrypt에서 DNS-01 방식으로 인증서를 자동 발급하고 갱신합니다.

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

API 토큰은 설정 파일이 아니라 `tapflow init`이 데이터 디렉터리에 만들어 두는 `.env` 파일(기본값 `~/.tapflow/data/.env`)에 적습니다. Cloudflare는 `TAPFLOW_CLOUDFLARE_TOKEN`, Vercel은 `TAPFLOW_VERCEL_TOKEN`을 씁니다. 팀 도메인이면 `TAPFLOW_VERCEL_TEAM_ID`도 함께 넣습니다. 설치 디렉터리가 git 저장소 안에 있으면 `tapflow init`이 데이터 디렉터리를 `.gitignore`에 추가하므로 이 파일은 커밋되지 않습니다. 데이터 디렉터리를 다른 곳으로 지정했다면 그 경로도 무시 목록에 들어 있는지 확인하세요. 환경변수로 직접 설정한 값이 있으면 파일보다 우선합니다. 이 파일이 어떻게 만들어지고 읽히는지는 [tapflow 설정](/ko/operate/configure)에서 다룹니다.

`publishAddress`가 켜져 있으면 릴레이가 부팅할 때 자기 LAN IP를 도메인 A 레코드로 발행하고 주기적으로 갱신합니다. 팀원은 DNS를 건드리지 않고 도메인만 열면 됩니다.

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

시작할 때 tapflow는 `localhost`가 아닌 첫 번째 구체적인 DNS SAN을 접속 주소로 안내하며, SAN 확장이 없으면 구체적인 subject CN을 사용합니다. DNS SAN이 있지만 사용할 수 있는 이름이 없으면(예: 와일드카드 전용 인증서) `localhost`를 안내하고 경고를 출력합니다. IP 전용 SAN이나 잘못된 인증서도 `localhost`로 돌아가지만 이 DNS SAN 경고는 출력하지 않습니다. 팀원이 이 주소를 사용하려면 안내된 이름이 릴레이의 LAN 주소로 해석되어야 합니다.

::: tip 접속과 알려진 제약
- 인증서는 도메인에 묶입니다. 따라서 `https://[도메인]:[포트]`로 접속해야 합니다. `localhost`나 IP로 접속하면 이름 불일치 경고가 납니다.
- 일부 공유기는 공개 도메인이 사설 IP를 가리키는 응답을 차단합니다(DNS rebinding). 이 경우 공유기에 예외를 등록하거나 로컬 DNS로 도메인을 LAN IP에 매핑하세요.
- WiFi 기기 격리(client isolation)가 켜진 망에서는 기기 간 통신이 막혀 LAN 접속 자체가 불가능합니다. 일반 가정·사무실 LAN을 사용하세요.
- 테스트로 스테이징 인증서(`TAPFLOW_ACME_STAGING=1`)를 발급하면 브라우저가 신뢰하지 않아 경고가 납니다. 같은 도메인을 스테이징에서 운영용으로 바꾼 직후에는 브라우저가 이전 인증서 오류를 캐시할 수 있습니다. 이때는 시크릿 창이나 기록 삭제로 다시 확인하세요.
:::

## 데이터 디렉터리 {#데이터-디렉토리}

설치 디렉터리는 다음과 같이 구성됩니다. `tapflow.config.json`, `AGENTS.md`, `CLAUDE.md`는 `tapflow init`이 만들고 DNS API 토큰으로 HTTPS를 고르면 `data/.env`도 만듭니다. `data/`의 나머지는 릴레이가 실행 중에 만듭니다.

```text
~/.tapflow/
  tapflow.config.json   ← 릴레이 설정 파일 (tapflow init으로 생성)
  AGENTS.md             ← 코딩 에이전트용 tapflow 섹션
  CLAUDE.md             ← @AGENTS.md
  data/                 ← 릴레이 런타임 상태
    tapflow.db          ← SQLite 데이터베이스
    jwt-secret          ← 설치별 서명 키
    .env                ← DNS 자동 발급을 쓸 때의 자격 증명
    uploads/
      builds/           ← .app.zip, .tar.gz, .apk 파일
      avatars/
      comments/
      team/             ← 팀 로고
    recordings/         ← 세션 녹화물 (72시간 후 삭제)
```

플로우 파일은 설치의 일부가 아닙니다. 앱 저장소의 `.tapflow/flows/`에 두고, 실패 스크린샷은 `.tapflow/artifacts/`에 쌓입니다.

데이터 디렉터리 위치를 변경하려면 `TAPFLOW_DATA_DIR` 환경변수 또는 `local.dataDir`을 사용합니다. 데이터 디렉터리를 백업하면 모든 데이터가 보존됩니다.

릴레이를 실행한 디렉터리에 데이터를 두던 버전에서 올라와도 아무것도 옮겨지지 않습니다. 그 디렉터리에 `tapflow.config.json`, `.tapflow/data`, `.tapflow-data` 중 하나가 있으면 계속 설치로 인정되므로 거기서 실행한 릴레이는 전과 똑같은 파일을 씁니다. `local.dataDir`도 옆에 있는 설정 파일 기준으로 풀리므로 구 `init`과 `tapflow migrate data-dir`이 써 둔 `.tapflow/data`가 그대로 유효합니다. 통합 레이아웃으로 바꾸려면 릴레이를 멈추고 `tapflow migrate data-dir`을 한 번 실행하세요. `.tapflow-data/`를 `.tapflow/data/`로 원자적 rename 하고(복사 없음, 유실 없음), `local.dataDir`이 구 기본값을 가리키면 다시 써주며, `.gitignore`도 갱신합니다.

## SMTP 설정

SMTP가 설정되지 않으면 초대 이메일과 비밀번호 재설정 이메일이 발송되지 않습니다. 이 경우 Admin이 초대 링크를 직접 복사해 공유할 수 있습니다.

팀 초대에 이메일을 사용하려면 `smtp.host`와 `smtp.user`, `smtp.pass`를 설정합니다.

## 웹훅

빌드 리뷰 상태가 `Done` 또는 `Rejected`로 바뀌면 tapflow가 등록된 URL로 POST합니다. `webhooks` 배열로 엔드포인트를 선언하고, REST API로도 런타임에 더 등록할 수 있습니다. 페이로드·서명 검증·발화 조건은 [웹훅](/ko/operate/webhooks)에서 다룹니다.

| 키 | 설명 |
|----|------|
| `webhooks[].url` | 알림을 받을 주소 (필수) |
| `webhooks[].secretEnv` | HMAC 서명 secret이 담긴 환경 변수 이름. secret은 config.json에 직접 두지 않습니다. |
| `webhooks[].enabled` | 활성 여부. 기본 `true` |

`webhooks` 변경은 릴레이를 다시 시작해야 반영됩니다.
