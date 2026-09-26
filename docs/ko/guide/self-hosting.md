# 릴레이 배포

릴레이는 경량 Node.js 서버입니다. WebSocket 트래픽 라우팅과 대시보드 서빙만 담당하므로 무거운 컴퓨팅 자원이 필요하지 않습니다.

::: info 릴레이 URL 두 가지 역할
- **대시보드 접속** — 브라우저에서 `http://localhost:4000` (로컬) 또는 `http://192.168.x.x:4000` (팀 내 접속)
- **에이전트 연결** — 릴레이가 다른 Mac에 있을 때: `tapflow agent start --relay ws://192.168.x.x:4000`. 에이전트→릴레이 구간은 LAN 내부로 연결합니다. 스킴은 `ws://`이고 릴레이에 `tls`를 설정해 HTTPS로 운영하면 `wss://`입니다. 원격 에이전트는 `agent` 스코프 토큰으로 인증합니다([원격 릴레이 인증](/ko/operate/agents#원격-릴레이-인증)).
:::

## 배포 시나리오

::: tip 에이전트와 릴레이는 같은 유선 LAN에 두세요
에이전트는 릴레이로 영상 프레임을 지속적으로 전송하므로 둘은 같은 LAN에 있어야 합니다. 같은 사무실 건물이라면 층이 다르거나 VLAN이 분리돼 있어도 내부 라우팅으로 지연이 충분히 낮습니다. 다만 에이전트를 인터넷 너머 다른 네트워크에 두면 RTT가 높아져 프레임이 드롭됩니다. **유선 이더넷을 권장합니다.** Wi-Fi도 동작하지만 Mac에서는 AWDL 때문에 끊길 수 있습니다. 끊김이 보이면 [스트림 지연·끊김](/ko/guide/troubleshooting#stream-lag)을 참고하세요.
:::

### Docker Compose (LAN 서버)

상시 켜져 있는 LAN 서버에서 Docker로 릴레이를 실행할 수 있습니다. 공식 이미지를 사용하여 깔끔하게 배포할 수 있으며, Node.js를 전역으로 설치할 필요가 없습니다.

```sh
docker pull tapflow/tapflow:latest
```

::: tip Docker Hub 받기 제한에 걸렸다면 GHCR을 쓰세요
Docker Hub는 로그인하지 않은 받기를 IP당 6시간에 100회로 제한합니다. 멀티 아키텍처 이미지는 아키텍처마다 한 번씩 세므로 실제로는 50회쯤이고, 같은 주소를 쓰는 모두가 그 횟수를 나눠 씁니다. CI 러너나 사무실 네트워크라면 특별한 일을 하지 않아도 닿습니다.

같은 이미지를 GitHub Container Registry에도 올립니다. 공개 이미지에는 이런 제한이 없습니다.

```sh
docker pull ghcr.io/jo-duchan/tapflow:latest
```

두 저장소는 같은 빌드가 만든 같은 digest를 받습니다. 그래서 `latest`든 버전 태그든 어느 쪽에서 받아도 같은 것입니다. 아래 Compose 파일의 `image:` 줄만 바꾸면 됩니다.
:::

`docker-compose.yml`을 만듭니다:

```yaml
services:
  relay:
    image: tapflow/tapflow:latest
    ports:
      - "4000:4000"
    volumes:
      - ./data:/app/.tapflow/data
    restart: unless-stopped
```

컨테이너를 시작합니다:

```sh
docker compose up -d
```

::: warning `publicUrl`을 설정하세요. 비우면 초대 링크가 받는 사람의 컴퓨터를 가리킵니다
릴레이는 `Host` 헤더로 자기 주소를 추론하지 않습니다. 위조된 헤더가 피싱 링크를 정상 초대 메일로
내보낼 수 있어서 일부러 그렇게 두었습니다. 설정이 없으면 `http://localhost:4000`으로 떨어집니다. 팀원에게 보낸 초대는
그 사람의 컴퓨터를 열고 실패합니다.

팀이 실제로 입력할 주소를 `TAPFLOW_RELAY_URL`에 설정합니다. 아래 변수들과 같은 `environment:`
블록입니다.

```yaml
    environment:
      - TAPFLOW_RELAY_URL=http://<docker-box-ip>:4000
```

설정 파일이 아니라 환경변수인 이유가 있습니다. 릴레이는 `tapflow.config.json`을 설치 디렉터리에서
읽고, 이미지에서는 `TAPFLOW_HOME`이 그 위치를 `/app`으로 고정합니다. Compose 볼륨이 마운트하는 것은
`/app/.tapflow/data`이므로 거기 둔 파일은 열리지 않습니다. 이 값은 CORS·CSRF 허용 목록에도 함께 들어갑니다. 프록시 뒤에 두는 배포에는
그쪽이 필요합니다.
:::

::: warning 브라우저를 열기 전에 첫 계정을 만드세요
`/setup` 온보딩은 루프백에서 온 요청에만 응답하는데 컨테이너는 브리지 게이트웨이를 거칩니다. 그래서 설정 페이지에는
폼 대신 호스트에서 `tapflow admin init`을 실행하라는 안내가 나오는데 릴레이 전용 이미지에는 CLI가
없습니다. `TAPFLOW_ADMIN_EMAIL`과 `TAPFLOW_ADMIN_PASSWORD`를 설정하면 릴레이가 시작하면서
계정을 만듭니다. 두 변수는 함께 설정해야 합니다. 비밀번호는 8자 이상이고 이미 소유자가 있는 설치에서는
아무 일도 하지 않습니다. 어느 `.env` 파일을 읽는지까지 자세한 내용은
[설정](/ko/reference/configuration#create-the-first-admin-account-in-a-docker-container-tapflow-admin-email)에
있습니다.
:::

::: danger 볼륨(volume)은 필수입니다
위의 `./data:/app/.tapflow/data` 볼륨 마운트는 반드시 필요합니다. 릴레이는 설치할 때 비밀 키를 하나 만들어 `<dataDir>/jwt-secret`에 쓰고 계속 재사용합니다. 볼륨이 없으면 이 파일이 컨테이너의 쓰기 계층에 놓입니다. `docker restart`는 그 계층이 남으므로 키도 유지되지만 컨테이너를 **다시 만들면** 키를 잃습니다. 이미지 업데이트, `docker compose down && docker compose up -d`, `docker rm`이 모두 여기 해당합니다. 키가 새로 생기면 모든 사용자가 즉시 로그아웃되고 에이전트 연결이 끊어집니다.
:::

**토폴로지:** 이 컨테이너는 릴레이만 실행합니다. 실제 시뮬레이터를 구동하는 에이전트는 같은 LAN의 Mac에서 실행되어야 하며, `agent` 스코프 토큰을 사용하여 이 Docker 서버로 아웃바운드 연결을 해야 합니다(`tapflow agent start --relay ws://<docker-box-ip>:4000 --token ...`).

**같은 네트워크 네임스페이스의 터널이나 프록시를 앞에 둔다면** `TAPFLOW_TUNNEL_PORT`(또는 `local.tunnelPort`)를 설정하고 그 포트로 연결하세요. 릴레이는 loopback으로 들어온 연결에 로그인을 요구하지 않고, 컨테이너의 네임스페이스를 공유하는 프록시는 그 경로로 연결합니다. 이 이미지에는 `tunnel` 설정을 보고 터널 포트를 여는 것이 없습니다. 그 일을 하는 쪽은 `tapflow start`와 `tapflow relay start`이며 이 이미지는 둘 다 실행하지 않습니다. 포트를 지정하는 것이 곧 여는 방법입니다. 다른 호스트의 프록시는 브리지를 거쳐 오므로 이미 원격으로 취급되며, 따로 설정할 것이 없습니다.

::: danger 릴레이를 클라우드에 직접 배포하지 마세요
fly.io 등 클라우드 서비스에 Docker 컨테이너를 올리면 에이전트→릴레이 구간이 인터넷을 타게 됩니다. 이 경우 RTT가 30fps 기준(33ms/frame)을 초과해 프레임 드롭이 발생하며 스트리밍 품질을 보장할 수 없습니다. tapflow는 이 구성을 지원하지 않습니다.
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

릴레이가 에이전트와 다른 머신에 있으므로 `agent` 스코프 토큰이 필요합니다. 발급 방법은 [원격 릴레이 인증](/ko/operate/agents#원격-릴레이-인증)을 참고하세요.

## 배포 설정

### JWT_SECRET

단일 릴레이라면 `JWT_SECRET`을 따로 설정하지 않아도 됩니다. 설정하지 않으면 릴레이가 최초 부팅 시 강력한 per-install 시크릿을 생성해 데이터 디렉터리(`jwt-secret`, 소유자 전용)에 저장합니다.

고정 키가 필요한 경우, 예를 들어 여러 릴레이 인스턴스가 하나의 시크릿을 공유해야 한다면 명시적으로 설정하세요. 안전한 랜덤 값을 생성합니다:

```sh
openssl rand -hex 32
```

생성된 값을 데이터 디렉터리의 `.env`(기본 설치에서는 `~/.tapflow/data/.env`)에 적으면 재시작할 때마다 다시 export하지 않아도 됩니다. 릴레이가 시작할 때 파일을 읽습니다:

```ini
JWT_SECRET=YOUR_JWT_SECRET
```

또는 셸 환경변수로 주입할 수 있으며, 이 값이 파일보다 우선합니다:

```sh
JWT_SECRET=YOUR_JWT_SECRET tapflow start
```

한 번 설정한 후에는 값을 유지하세요. 변경하면 기존 세션이 즉시 모두 만료됩니다. 시크릿이 유출됐거나 의도적으로 전체 세션을 초기화할 때만 교체하면 됩니다.

### tapflow.config.json

릴레이는 이 머신의 설치 디렉터리에서 `tapflow.config.json`을 읽습니다. 기본값은 `~/.tapflow`이고 `TAPFLOW_HOME`으로 바꿉니다. 서버에서는 서비스 환경에 `TAPFLOW_HOME`을 설정하세요. 그래야 유닛과 셸, 직접 실행하는 `tapflow` 명령이 같은 설치를 가리킵니다. [설정 파일](/ko/reference/configuration)을 참고하세요.

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

릴레이는 localhost 밖에서 오는 모든 연결에 인증을 요구합니다. 브라우저는 로그인으로, 에이전트는 `agent` 스코프 토큰으로 인증합니다 — 에이전트 쪽 절차는 [원격 릴레이 인증](/ko/operate/agents#원격-릴레이-인증)에서 다룹니다.

tapflow는 두 가지 터널 프로바이더를 지원합니다:

::: tip 터널 설정은 tapflow init이 만들어 줍니다
아래에 보이는 `tunnel` 블록은 `tapflow init`을 실행하고 프로바이더를 고르면 대화형으로 생성됩니다. [tapflow 설정](/ko/operate/configure)을 참고하세요. 여기서는 생성된 설정과 프로바이더 쪽 준비 과정을 다룹니다.
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

::: warning tailscaled는 TUN 모드로 실행하세요
릴레이는 릴레이 포트에 loopback으로 들어온 연결에 로그인을 요구하지 않습니다. userspace-networking 모드(`tailscaled --tun=userspace-networking`, 컨테이너에서 흔함)에서는 Tailscale이 tailnet 연결을 모두 릴레이 머신 안에서 넘겨주므로, 이 방문자들은 로그인 없이 들어옵니다. 기본값인 TUN 모드를 쓰세요. `tapflow start`와 `tapflow relay start`는 userspace 모드를 감지하면 경고합니다.
:::

#### HTTPS로 더 부드러운 스트림 켜기 (선택)

기본 접속은 평문 HTTP이고 tailnet 주소는 외부 주소로 분류되므로 팀원은 1000px로 줄인 스트림을 WASM 디코더로 받습니다. Tailscale의 무료 HTTPS로 종단하면 터널 포트를 거쳐 들어오므로 Smooth 프로파일(원본 해상도, 하드웨어 디코딩)로 전환됩니다([스트림 품질](/ko/operate/streaming-quality) 참고). Tailscale이 `*.ts.net` 인증서를 자동 발급·갱신하므로 도메인이나 DNS 토큰이 필요 없습니다.

1. Tailscale admin 콘솔의 **DNS** 설정에서 **MagicDNS**와 **HTTPS Certificates**를 켭니다. 머신 이름이 공개 Certificate Transparency 기록에 남는다는 점에 동의해야 합니다.
2. 릴레이 Mac에서 릴레이의 **터널 포트** 앞에 HTTPS를 둡니다. 기본값은 `4001`이고, `TAPFLOW_TUNNEL_PORT`를 정했거나 릴레이 자신이 4001을 쓰면 4002로 비켜섭니다. 시작 배너에 실제로 잡은 포트가 나오니 아래 명령에는 그 번호를 쓰세요. Tailscale이 인증서를 자동 관리하므로 별도 발급 명령은 필요 없습니다:

```sh
tailscale serve --bg 4001
```

::: warning tailscale serve는 4000이 아니라 터널 포트로
`tailscale serve`는 릴레이 Mac 안에서 릴레이로 연결합니다. `4000` 포트에서는 릴레이가 이 연결을 로컬로 보고 로그인을 요구하지 않습니다. 터널 포트에서는 모든 연결을 원격으로 봅니다. 예전 설정이 `4000`을 serve하고 있다면 `tailscale serve reset`을 실행한 뒤 위 명령을 다시 실행하세요. 예전 설정이 남아 있는 동안 `tapflow start`가 경고합니다.
:::

3. `tapflow.config.json`의 `publicUrl`을 HTTPS 주소로 바꿔 배너·안내 URL을 맞춥니다:

```json
{
  "tunnel": {
    "provider": "tailscale",
    "publicUrl": "https://your-hostname.tailnet.ts.net"
  }
}
```

팀원이 이 HTTPS 주소로 접속하면 Smooth 프로파일로 스트리밍됩니다. 릴레이 자체는 HTTP로 두며 `tls` 설정은 필요 없습니다. TLS는 Tailscale이 앞단에서 종단합니다.

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

터널 토큰을 데이터 디렉터리의 `.env`(기본 설치에서는 `~/.tapflow/data/.env`)에 적습니다:

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

릴레이 Mac에서 터널은 방문자를 `4000`이 아니라 릴레이의 **터널 포트**(`127.0.0.1:4001`)로 넘깁니다. 이 포트로 들어온 연결은 Mac 안에서 왔더라도 릴레이가 모두 원격으로 보므로, 방문자는 로그인하고 도구는 토큰을 내야 합니다. `4001`을 다른 프로그램이 쓰고 있다면 `TAPFLOW_TUNNEL_PORT`를 설정하세요. tapflow는 배너에 표시된 포트로 터널을 연결합니다.

::: tip VPS 방화벽
VPS에서 `2333/tcp`(rathole)와 `443/tcp`(Caddy)를 열어야 합니다. `4000` 포트는 닫아 두세요. Caddy는 VPS 안에서 이 포트에 연결합니다. 외부에서 직접 연결하면 TLS를 거치지 않습니다.
:::

::: danger 릴레이를 클라우드에 직접 배포하지 마세요
fly.io, Railway 등 클라우드 서비스에 릴레이를 올리면 에이전트→릴레이 구간이 인터넷을 타게 됩니다. 이 경우 RTT가 30fps 기준(33ms/frame)을 초과해 프레임 드롭이 발생하며 스트리밍 품질을 보장할 수 없습니다. tapflow는 이 구성을 지원하지 않습니다.
:::

## 백업

릴레이의 영속 상태는 실제 사용되는 데이터 디렉터리 아래에 저장됩니다. 기본 설치는 `~/.tapflow/data/`이고, 이전 버전에서 자기 폴더에 만든 설치는 `<설치>/.tapflow/data/`입니다. `tapflow start`와 `tapflow relay start`가 시작할 때 그 경로를 출력하고, `TAPFLOW_DATA_DIR`가 `local.dataDir`를 덮어씁니다. OS 업그레이드, 릴레이 이전, 장기 팀 파일럿 전에는 이 디렉터리를 백업하세요.

`.tapflow-data/`에 상태를 저장하던 버전에서 올라와도 깨지지 않습니다. 지정된 `local.dataDir`은 그대로 존중되고, config 없는 설치는 기존 `.tapflow-data/`를 계속 읽습니다. 통합 레이아웃을 적용하려면 릴레이를 멈추고 `tapflow migrate data-dir`을 한 번 실행하세요. `.tapflow-data/`를 `.tapflow/data/`로 원자적 rename 하고(복사 없음, 데이터 유실 없음), `local.dataDir`이 구 기본값을 가리키면 다시 써주며, `.gitignore`도 갱신합니다.

아래 경로는 모두 그 데이터 디렉터리 안에 있습니다. `tapflow start`가 출력하는 `Data →` 줄의 경로입니다.

주요 경로:

| 경로 | 중요한 이유 |
|------|-------------|
| `tapflow.db` | 계정, 앱, 빌드, 세션, 댓글, 토큰, 설정을 담는 SQLite 데이터베이스입니다. |
| `tapflow.db-wal` / `tapflow.db-shm` | SQLite WAL 보조 파일입니다. 파일시스템 스냅샷에 함께 포함하거나, Litestream을 사용해 변경분을 안전하게 캡처하세요. |
| `uploads/` | 릴레이가 제공하는 업로드된 빌드 아티팩트입니다. |
| `recordings/` | 릴레이를 통해 업로드된 세션 녹화 파일입니다. |
| `.env`와 `jwt-secret` | 릴레이 시크릿입니다. 비공개로 보관하고 데이터 디렉터리와 함께 복원해야 기존 세션과 연동이 유지됩니다. |

### 권장: SQLite에는 Litestream 사용

[Litestream](https://litestream.io/)은 외부 프로세스입니다. tapflow가 Litestream을 번들링, 설치, 관리하지 않습니다. Litestream은 SQLite WAL 변경분을 AWS S3, Cloudflare R2, Backblaze B2, 또는 S3 호환 스토리지로 스트리밍합니다. tapflow 스키마 변경이나 별도 데이터베이스 서버가 필요 없습니다.

릴레이 호스트에 Litestream을 설치합니다:

```sh
brew install litestream
```

Linux에서는 공식 릴리스 페이지에서 아키텍처에 맞는 Litestream 릴리스 바이너리를 설치하세요.

tapflow 설정 파일 옆에 `litestream.yml`을 만듭니다. 데이터베이스 경로는 절대 경로로 씁니다. 상대 경로는 Litestream 자신의 작업 디렉터리 기준이라 설치 디렉터리와 다를 수 있습니다:

```yaml
dbs:
  - path: /Users/you/.tapflow/data/tapflow.db
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
DATA_DIR=/Users/you/.tapflow/data   # ~/.tapflow/data, $TAPFLOW_HOME/data, 또는 설정한 TAPFLOW_DATA_DIR
litestream restore -config litestream.yml -if-replica-exists "$DATA_DIR/tapflow.db"
```

경로는 tapflow를 실행해서 출력을 보는 대신 위 규칙으로 정하세요. 처음 시작할 때 빈 `tapflow.db`가 만들어지고, `litestream restore`는 이미 있는 데이터베이스를 덮어쓰지 않습니다.

그다음 같은 데이터 디렉터리 안의 `uploads/`, `recordings/`, `.env`, `jwt-secret`을 파일 백업에서 복원하세요. Litestream은 SQLite 데이터베이스만 보호합니다. 빌드 파일, 녹화 파일, 시크릿은 별도의 파일시스템 또는 오브젝트 스토리지 백업이 필요합니다.

## PM2 (릴레이 Mac 상시 운영)

릴레이 Mac에서 크래시 시 자동 재시작, 재부팅 후 자동 시작, 로그 관리를 처리합니다.

```sh
npm install -g pm2 tapflow
```

`JWT_SECRET`을 데이터 디렉터리의 `.env`(기본 설치에서는 `~/.tapflow/data/.env`)에 넣어 두거나 비워 두고(비우면 자동 생성) 다음으로 시작합니다:

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
릴레이가 실행되면 브라우저에서 `http://localhost:4000`을 열면 설정 페이지로 자동 이동합니다. 브라우저를 사용할 수 없는 서버 환경이라면 `tapflow admin init`을 사용하세요. 이메일과 비밀번호를 물어보므로 프로비저닝 스크립트가 아니라 터미널에서 실행해야 합니다. 팀원 초대와 첫 빌드 업로드는 [대시보드 최초 설정](/ko/dashboard/setup)을 참고하세요.
:::

## systemd (Linux 릴레이 서버)

릴레이를 Linux 호스트에서 실행하고 부팅 시 자동 시작, 크래시 후 재시작, journald 로그 관리를 원한다면 systemd를 사용하세요. 먼저 tapflow를 전역으로 설치합니다:

```sh
npm install -g tapflow
```

전용 사용자와 데이터 디렉터리를 만듭니다:

```sh
sudo useradd --system --create-home --home-dir /var/lib/tapflow --shell /usr/sbin/nologin tapflow
sudo mkdir -p /etc/tapflow /var/lib/tapflow/.tapflow/data
sudo chown -R tapflow:tapflow /var/lib/tapflow
```

릴레이 시크릿은 `/etc/tapflow/relay.env`에 둡니다. 기존 [JWT_SECRET](#jwt-secret) 섹션은 릴레이가 데이터 디렉터리에서 직접 읽는 `.env` 방식도 설명합니다:

```ini
TAPFLOW_DATA_DIR=/var/lib/tapflow/.tapflow/data
JWT_SECRET=YOUR_JWT_SECRET
```

`TAPFLOW_HOME`만 두면 데이터는 `/var/lib/tapflow/data`에 놓입니다. 그런데도 `TAPFLOW_DATA_DIR`을 함께 적는 이유는, 설치 디렉터리 개념이 생기기 전에 구축한 서버와 같은 경로를 쓰기 위해서입니다. 새로 만드는 서버에서 짧은 레이아웃을 쓰려면 이 줄을 빼고 위 `mkdir`의 `/var/lib/tapflow/.tapflow/data`도 `/var/lib/tapflow/data`로 바꾸세요. 비어 있더라도 `.tapflow/data` 폴더가 있으면 릴레이는 그 폴더를 기존 데이터로 보고 계속 사용합니다.

`JWT_SECRET`은 `openssl rand -hex 32`로 생성하고, `/etc/tapflow/relay.env`는 root만 읽을 수 있게 제한합니다:

```sh
sudo chmod 600 /etc/tapflow/relay.env
```

`/etc/systemd/system/tapflow-relay.service`를 만듭니다:

```ini
[Unit]
Description=tapflow relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tapflow
Group=tapflow
WorkingDirectory=/var/lib/tapflow
Environment=TAPFLOW_HOME=/var/lib/tapflow
EnvironmentFile=/etc/tapflow/relay.env
ExecStart=/usr/bin/env tapflow relay start
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/tapflow

[Install]
WantedBy=multi-user.target
```

하드닝 지시어는 파일 시스템을 읽기 전용으로 유지하되
`/var/lib/tapflow`만 쓰기 가능하게 둡니다. 이 경로 안에 위에서 설정한
`TAPFLOW_DATA_DIR`이 들어 있고, 릴레이는 그 밖에 쓰지 않으므로 더 열어줄
경로는 없습니다. `TAPFLOW_DATA_DIR`을 옮겼다면 새 경로를
`ReadWritePaths`에 추가하세요.

예외가 하나 있습니다. `ProtectHome=true`는 `/home`·`/root`·`/run/user`를
아예 접근 불가로 만들고, `ReadWritePaths`로는 그 안의 경로를 다시 열 수
없습니다. 데이터 디렉터리를 그 아래에 두면 무엇을 나열하든 서비스가 보지
못합니다. 다른 곳에 두거나 `ProtectHome=read-only`로 바꾸세요. 위에서
`tapflow` 사용자의 홈을 `/home`이 아니라 `/var/lib/tapflow`로 만든 것도
같은 이유입니다.

기본값이 아닌 포트나 다른 설정이 필요하다면 `tapflow.config.json`을 `/var/lib/tapflow`에 둡니다. 위의 `TAPFLOW_HOME`이 그 디렉터리를 설치 디렉터리로 만듭니다. 직접 `tapflow` 명령을 실행할 때도 같은 변수를 셸에 설정하세요. 그러지 않으면 서비스가 아니라 홈 디렉터리의 기본 설치를 읽습니다.

서비스를 활성화하기 전에 스모크 테스트를 먼저 실행하세요. 문제가 5초마다
재시작하는 유닛이 아니라 읽을 수 있는 메시지로 드러납니다. `systemd-run`은
유닛과 같은 샌드박스를 적용합니다 — 그냥 `sudo -u tapflow`로 띄우면 위
지시어들이 빠지는데, 정작 문제가 되는 것은 대개 그쪽입니다.

```sh
sudo systemd-run --pty --unit=tapflow-smoke   --property=User=tapflow --property=Group=tapflow   --property=WorkingDirectory=/var/lib/tapflow   --property=Environment=TAPFLOW_HOME=/var/lib/tapflow   --property=EnvironmentFile=/etc/tapflow/relay.env   --property=NoNewPrivileges=true   --property=ProtectSystem=strict   --property=ProtectHome=true   --property=PrivateTmp=true   --property=ReadWritePaths=/var/lib/tapflow   /usr/bin/env tapflow relay start
```

다른 셸에서 릴레이가 응답하는지 확인합니다. 기본값에 기대지 말고 URL을
직접 지정하세요. `tapflow status`는 서비스의 설정이 아니라 **그 셸의**
설정을 읽어 릴레이를 찾으므로, `/var/lib/tapflow/tapflow.config.json`에
지정한 포트는 이 셸이 알지 못합니다.

위 명령이 시작할 때 출력한 주소(`Relay : …`)를 그대로 복사하세요.
`--relay`는 그 형태를 받아 스킴을 알아서 바꾸므로 TLS 배포에서도 고칠
것이 없습니다.

```sh
tapflow status --relay http://localhost:4000   # `Relay :`에 찍힌 값
```

상태 확인이 끝나면 Ctrl-C로 포그라운드 릴레이를 중지합니다.

서비스를 활성화하고 시작합니다:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now tapflow-relay
sudo systemctl status tapflow-relay
```

로그는 다음으로 확인합니다:

```sh
journalctl -u tapflow-relay -f
```

전역 패키지를 업데이트한 뒤에는 서비스를 재시작합니다:

```sh
npm update -g tapflow
sudo systemctl restart tapflow-relay
```
