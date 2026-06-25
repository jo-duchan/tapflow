# 릴레이 배포

릴레이는 경량 Node.js 서버입니다. WebSocket 트래픽 라우팅과 대시보드 서빙만 담당하므로 무거운 컴퓨팅 자원이 필요하지 않습니다.

::: info 릴레이 URL 두 가지 역할
- **대시보드 접속** — 브라우저에서 `http://localhost:4000` (로컬) 또는 `http://192.168.x.x:4000` (팀 내 접속)
- **에이전트 연결** — 릴레이가 다른 Mac에 있을 때: `tapflow agent start --relay ws://192.168.x.x:4000`. 에이전트→릴레이 구간은 항상 LAN 내부 `ws://`를 사용하며, 원격 에이전트는 `agent` 스코프 토큰으로 인증합니다([원격 릴레이 인증](/ko/guide/agent#원격-릴레이-인증)).
:::

## 배포 시나리오

::: tip 에이전트와 릴레이는 같은 유선 LAN에 두세요
에이전트는 릴레이로 영상 프레임을 지속적으로 전송하므로 둘은 같은 LAN에 있어야 합니다. 같은 사무실 건물이라면 층이 다르거나 VLAN이 분리돼 있어도 내부 라우팅으로 지연이 충분히 낮습니다. 다만 에이전트를 인터넷 너머 다른 네트워크에 두면 RTT가 높아져 프레임이 드롭됩니다. **유선 이더넷을 권장합니다.** Wi-Fi도 동작하지만 Mac에서는 AWDL 때문에 끊길 수 있습니다. 끊김이 보이면 [스트림 지연·끊김](/ko/guide/troubleshooting#stream-lag)을 참고하세요.
:::

### 로컬 운영 (Mac 한 대)

릴레이와 에이전트를 같은 Mac에서 한 번에 실행합니다.

```sh
tapflow start
```

### 팀 운영 (릴레이 서버 분리)

릴레이는 전용 Mac에서, 에이전트는 시뮬레이터가 연결된 각 Mac에서 실행합니다.

**릴레이 Mac에서:**

```sh
tapflow relay start
```

**각 에이전트 Mac에서:**

```sh
tapflow agent start --relay ws://192.168.x.x:4000 --token tflw_pat_xxxxxxxx
```

릴레이가 에이전트와 다른 머신에 있으므로 `agent` 스코프 토큰이 필요합니다. 발급 방법은 [원격 릴레이 인증](/ko/guide/agent#원격-릴레이-인증)을 참고하세요.

## 배포 설정

### JWT_SECRET

단일 릴레이라면 `JWT_SECRET`을 따로 설정하지 않아도 됩니다. 설정하지 않으면 릴레이가 최초 부팅 시 강력한 per-install 시크릿을 생성해 데이터 디렉토리(`jwt-secret`, 소유자 전용)에 저장합니다.

고정 키가 필요한 경우, 예를 들어 여러 릴레이 인스턴스가 하나의 시크릿을 공유해야 한다면 명시적으로 설정하세요. 안전한 랜덤 값을 생성합니다:

```sh
openssl rand -hex 32
```

생성된 값을 `.tapflow-data/.env`에 적으면 재시작할 때마다 다시 export하지 않아도 됩니다. 릴레이가 시작할 때 파일을 읽습니다:

```ini
JWT_SECRET=YOUR_JWT_SECRET
```

또는 셸 환경변수로 주입할 수 있으며, 이 값이 파일보다 우선합니다:

```sh
JWT_SECRET=YOUR_JWT_SECRET tapflow start
```

한 번 설정한 후에는 값을 유지하세요. 변경하면 기존 세션이 즉시 모두 만료됩니다. 시크릿이 유출됐거나 의도적으로 전체 세션을 초기화할 때만 교체하면 됩니다.

### tapflow.config.json

릴레이는 현재 디렉토리에서 `tapflow.config.json`을 읽습니다. [설정 파일](/ko/reference/configuration)을 참고하세요.

## 내부 접속 (같은 네트워크)

같은 사무실 건물 내 팀원이 대시보드에 접근하는 가장 간단한 방법입니다.

```sh
npm install -g tapflow
tapflow start
```

단일 릴레이는 `JWT_SECRET`을 자동 생성하므로 여기서 따로 설정할 값이 없습니다. 고정 키가 필요하면 위의 [JWT_SECRET](#jwt-secret)을 참고하세요.

팀원은 `http://MAC_LOCAL_IP:4000`으로 대시보드에 접속합니다. 포트는 `tapflow.config.json`의 `local.port` 값을 따릅니다 (기본값 `4000`).

## 외부 접속

릴레이와 에이전트는 항상 같은 내부 네트워크에 유지합니다. 외부 접속은 릴레이 Mac에서 외부로 아웃바운드 터널을 열어 브라우저가 공개 URL로 접근하도록 합니다.

릴레이는 localhost 밖에서 오는 모든 연결에 인증을 요구합니다. 브라우저는 로그인으로, 에이전트는 `agent` 스코프 토큰으로 인증합니다 — 에이전트 쪽 절차는 [원격 릴레이 인증](/ko/guide/agent#원격-릴레이-인증)에서 다룹니다.

tapflow는 두 가지 터널 프로바이더를 지원합니다:

::: tip 터널 설정은 tapflow init이 만들어 줍니다
아래에 보이는 `tunnel` 블록은 `tapflow init`을 실행하고 프로바이더를 고르면 대화형으로 생성됩니다. [tapflow 설정](/ko/guide/configure)을 참고하세요. 여기서는 생성된 설정과 프로바이더 쪽 준비 과정을 다룹니다.
:::

| | Tailscale | VPS + rathole |
|---|-----------|---------------|
| **설정** | 앱 설치 + 로그인 | SSH 접근 가능한 VPS 필요 |
| **비용** | 무료 (6인 이하) 또는 유료 | VPS 운영 비용 |
| **접속 가능 대상** | Tailscale tailnet 멤버만 | URL을 아는 누구나 |
| **적합한 경우** | 내부 팀 | 외부 협력사, 공개 데모 |

### Tailscale (권장)

[Tailscale](https://tailscale.com)은 WireGuard 기반 제로 설정 VPN입니다. 포트 포워딩이나 공인 IP 없이 기기 간 암호화 오버레이 네트워크("tailnet")를 구성합니다.

```text
브라우저 (tailnet) ──[WireGuard E2E]──► 릴레이 Mac (tailnet)
                                               ↑
                                       에이전트 Mac (같은 내부 네트워크)
```

트래픽이 평문으로 팀 인프라를 벗어나지 않습니다. Tailscale의 DERP 릴레이를 폴백으로 사용하더라도 암호화된 WireGuard 패킷만 중계되며 Tailscale 서버도 복호화할 수 없습니다.

**사전 조건**: 릴레이 Mac과 접속할 브라우저 머신 모두에 Tailscale을 설치해야 합니다.

- [Tailscale 다운로드 →](https://tailscale.com/download) — macOS, Windows, Linux, iOS, Android
- 무료 플랜: 최대 6인 · [요금제 →](https://tailscale.com/pricing)

1. 릴레이 Mac에서 Tailscale을 설치하고 연결합니다:

```sh
brew install tailscale   # macOS
sudo tailscale up
```

2. `tapflow.config.json`에 `tunnel` 섹션 추가:

```json
{
  "tunnel": {
    "provider": "tailscale"
  }
}
```

3. 시작합니다. 배포 시나리오에 따라 명령이 다릅니다.

Mac 한 대로 릴레이와 에이전트를 함께 운영 중이라면:

```sh
tapflow start
```

릴레이를 전용 Mac에서 따로 운영 중이라면:

```sh
tapflow relay start
```

tapflow가 Tailscale MagicDNS 호스트명(또는 tailnet IP)을 자동으로 읽어 배너에 공개 URL을 출력합니다. Tailscale이 설치된 팀원은 그 URL로 브라우저에서 접속합니다.

::: tip 커스텀 URL
config의 `tunnel` 섹션에 `"publicUrl": "http://your-hostname.tailnet.ts.net:4000"` 을 추가하면 자동 감지 URL을 덮어쓸 수 있습니다.
:::

::: info 에이전트는 내부 네트워크 유지
Tailscale은 브라우저→릴레이 경로만 제공합니다. 에이전트(시뮬레이터 Mac)는 계속 LAN 내부 IP로 릴레이에 연결합니다 — 에이전트 설정 변경 없이 사용 가능합니다.
:::

#### HTTPS로 더 부드러운 스트림 켜기 (선택)

기본 접속은 평문 HTTP라 팀원에게 Standard 프로파일이 적용됩니다. Tailscale의 무료 HTTPS로 종단하면 Smooth 프로파일로 전환됩니다([스트림 품질](/ko/guide/streaming) 참고). Tailscale이 `*.ts.net` 인증서를 자동 발급·갱신하므로 도메인이나 DNS 토큰이 필요 없습니다.

1. Tailscale admin 콘솔의 **DNS** 설정에서 **MagicDNS**와 **HTTPS Certificates**를 켭니다. 머신 이름이 공개 Certificate Transparency 기록에 남는다는 점에 동의해야 합니다.
2. 릴레이 Mac에서 relay 포트를 HTTPS로 종단합니다. Tailscale이 인증서를 자동 관리하므로 별도 발급 명령은 필요 없습니다:

```sh
tailscale serve 4000
```

3. `tapflow.config.json`의 `publicUrl`을 HTTPS 주소로 바꿔 배너·안내 URL을 맞춥니다:

```json
{
  "tunnel": {
    "provider": "tailscale",
    "publicUrl": "https://your-hostname.tailnet.ts.net"
  }
}
```

팀원이 이 HTTPS 주소로 접속하면 Smooth 프로파일로 스트리밍됩니다. 릴레이 자체는 HTTP(4000)로 두며 `tls` 설정은 필요 없습니다. TLS는 Tailscale이 앞단에서 종단합니다.

### VPS + rathole

외부 협력사, 익명 데모, 또는 Tailscale을 사용할 수 없을 때 완전한 공개 URL이 필요한 경우에 사용합니다. 트래픽은 팀 소유 VPS를 경유합니다.

```text
브라우저 → VPS (공개 URL) → 터널 → 릴레이 Mac (사무실)
                                      ↑
                                 에이전트 Mac (같은 내부 네트워크)
```

tapflow는 [rathole](https://github.com/rapiz1/rathole) — 경량 리버스 터널 도구 — 을 사용합니다. tapflow가 rathole을 자동으로 관리하므로 VPS에서 수동 설치가 필요 없습니다.

**사전 조건**:
- SSH 접근 가능한 VPS. 어떤 공급사든 무관합니다 (1 vCPU + 512 MB RAM으로 충분). 예: [Hetzner](https://www.hetzner.com), [DigitalOcean](https://www.digitalocean.com), [Vultr](https://www.vultr.com).
- HTTPS를 위한 도메인 또는 [sslip.io](https://sslip.io) ([Caddy](https://caddyserver.com)가 처리).
- `TAPFLOW_TUNNEL_TOKEN` — 직접 정하는 임의의 비밀 문자열. 릴레이 Mac과 rathole 서버 간 터널 인증에 사용됩니다.

릴레이 Mac에서 SSH를 통해 VPS로 아웃바운드 터널을 열기 때문에 포트 포워딩이나 CGNAT 없이도 외부 접속이 가능합니다.

#### 1. VPS에 Caddy 설치

Caddy는 TLS 인증서를 자동으로 발급·갱신합니다 — certbot 별도 설치가 필요 없습니다.

```sh
sudo apt install -y caddy
```

```caddyfile
# /etc/caddy/Caddyfile
your-vps.com {
    reverse_proxy localhost:4000
}
```

```sh
sudo systemctl reload caddy
```

::: tip 도메인이 없다면 sslip.io를 사용하세요
도메인을 별도로 구매하지 않아도 `<VPS_IP>.sslip.io` 형태로 무료 HTTPS를 사용할 수 있습니다. 예를 들어 `https://1.2.3.4.sslip.io` — Caddy가 Let's Encrypt 인증서를 자동 발급합니다.
:::

#### 2. 릴레이 Mac에서 tapflow 설정

`tapflow.config.json`에 `tunnel` 섹션을 추가합니다:

```json
{
  "tunnel": {
    "provider": "rathole",
    "serverAddr": "your-vps.com:2333",
    "publicUrl": "https://your-vps.com",
    "ssh": {
      "host": "your-vps.com",
      "user": "ubuntu",
      "keyPath": "~/.ssh/id_ed25519"
    }
  }
}
```

터널 토큰을 `.tapflow-data/.env`에 적습니다:

```ini
TAPFLOW_TUNNEL_TOKEN=your-secret-token
```

그다음 시작합니다. Mac 한 대로 운영 중이라면:

```sh
tapflow start
```

릴레이를 전용 Mac에서 따로 운영 중이라면:

```sh
tapflow relay start
```

tapflow가 SSH로 VPS에 접속해 첫 실행 시 rathole을 자동으로 설치하고, VPS 서버와 로컬 클라이언트를 모두 실행합니다. 터널이 연결되면 배너에 공개 URL이 출력됩니다.

브라우저는 `https://your-vps.com`으로 접속하고, 에이전트는 릴레이의 내부 IP(`ws://192.168.x.x:4000`)로 연결합니다.

::: tip VPS 방화벽
VPS에서 `2333/tcp`(rathole)와 `443/tcp`(Caddy)를 열어야 합니다. `4000` 포트는 공개할 필요 없습니다 — Caddy가 내부에서 프록시합니다.
:::

::: danger 릴레이를 클라우드에 직접 배포하지 마세요
fly.io, Railway 등 클라우드 서비스에 릴레이를 올리면 에이전트→릴레이 구간이 인터넷을 타게 됩니다. 이 경우 RTT가 30fps 기준(33ms/frame)을 초과해 프레임 드롭이 발생하며 스트리밍 품질을 보장할 수 없습니다. tapflow는 이 구성을 지원하지 않습니다.
:::

## 백업

릴레이의 영속 상태는 `tapflow.config.json`의 `local.dataDir` 아래에 저장됩니다(기본값: `.tapflow-data/`). OS 업그레이드, 릴레이 이전, 장기 팀 파일럿 전에는 이 디렉토리를 백업하세요.

주요 경로:

| 경로 | 중요한 이유 |
|------|-------------|
| `.tapflow-data/tapflow.db` | 계정, 앱, 빌드, 세션, 댓글, 토큰, 설정을 담는 SQLite 데이터베이스입니다. |
| `.tapflow-data/tapflow.db-wal` / `.tapflow-data/tapflow.db-shm` | SQLite WAL 보조 파일입니다. 파일시스템 스냅샷에 함께 포함하거나, Litestream을 사용해 변경분을 안전하게 캡처하세요. |
| `.tapflow-data/uploads/` | 릴레이가 제공하는 업로드된 빌드 아티팩트입니다. |
| `.tapflow-data/recordings/` | 릴레이를 통해 업로드된 세션 녹화 파일입니다. |
| `.tapflow-data/.env`와 `.tapflow-data/jwt-secret` | 릴레이 시크릿입니다. 비공개로 보관하고 데이터 디렉토리와 함께 복원해야 기존 세션과 연동이 유지됩니다. |

### 권장: SQLite에는 Litestream 사용

[Litestream](https://litestream.io/)은 SQLite WAL 변경분을 AWS S3, Cloudflare R2, Backblaze B2, 또는 S3 호환 스토리지로 스트리밍합니다. tapflow 스키마 변경이나 별도 데이터베이스 서버가 필요 없습니다.

릴레이 호스트에 Litestream을 설치합니다:

```sh
brew install litestream
```

tapflow 설정 파일 옆에 `litestream.yml`을 만듭니다:

```yaml
dbs:
  - path: .tapflow-data/tapflow.db
    replicas:
      - type: s3
        bucket: YOUR_BUCKET
        path: tapflow/relay/tapflow.db
        endpoint: YOUR_S3_ENDPOINT
```

스토리지 공급자가 요구하는 인증 정보를 설정한 뒤, 릴레이와 함께 Litestream을 실행합니다:

```sh
litestream replicate -config litestream.yml
```

PM2를 사용한다면 릴레이와 Litestream을 별도 프로세스로 두어 각각 독립적으로 재시작되게 합니다:

```sh
pm2 start tapflow --name relay -- relay start
pm2 start litestream --name relay-backup -- replicate -config litestream.yml
pm2 save
```

새 호스트에서 tapflow를 시작하기 전에 데이터베이스를 복원합니다:

```sh
litestream restore -config litestream.yml -if-replica-exists .tapflow-data/tapflow.db
```

그다음 `.tapflow-data/uploads/`, `.tapflow-data/recordings/`, `.tapflow-data/.env`, `.tapflow-data/jwt-secret`를 파일 백업에서 복원하세요. Litestream은 SQLite 데이터베이스만 보호합니다. 빌드 파일, 녹화 파일, 시크릿은 별도의 파일시스템 또는 오브젝트 스토리지 백업이 필요합니다.

## PM2 (릴레이 Mac 상시 운영)

릴레이 Mac에서 크래시 시 자동 재시작, 재부팅 후 자동 시작, 로그 관리를 처리합니다.

```sh
npm install -g pm2 tapflow
```

`JWT_SECRET`을 `.tapflow-data/.env`에 넣어 두면(또는 비워 두면 자동 생성) 다음으로 시작합니다:

```sh
pm2 start tapflow --name relay -- relay start
pm2 save
pm2 startup
```

tapflow를 업데이트할 때는:

```sh
npm update -g tapflow
pm2 restart relay
```

::: tip 다음 단계
릴레이가 실행되면 브라우저에서 `http://localhost:4000`을 열면 설정 페이지로 자동 이동합니다. 브라우저를 사용할 수 없는 서버 환경이라면 `tapflow admin init`을 사용하세요. 팀원 초대와 첫 빌드 업로드는 [대시보드 최초 설정](/ko/dashboard/setup)을 참고하세요.
:::
