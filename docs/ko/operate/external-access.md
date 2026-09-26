---
title: 외부 접속
description: 사무실 밖에서 아웃바운드 터널로 릴레이에 접속합니다. tailnet 구성원끼리는 Tailscale을, 공개 URL이 필요하면 직접 운영하는 VPS와 rathole을 씁니다. Smooth 프로파일이 필요하면 HTTPS를 켭니다.
---

# 외부 접속

릴레이와 에이전트는 항상 같은 내부 네트워크에 유지합니다. 외부 접속은 릴레이 Mac에서 외부로 아웃바운드 터널을 열어 브라우저가 공개 URL로 접근하도록 합니다.

릴레이는 localhost 밖에서 오는 모든 연결에 인증을 요구합니다. 브라우저는 로그인으로, 에이전트는 `agent` 스코프 토큰으로 인증합니다 — 에이전트 쪽 절차는 [원격 릴레이 인증](/ko/operate/agents#원격-릴레이-인증)에서 다룹니다.

tapflow는 두 가지 터널 프로바이더를 지원합니다:

::: tip 터널 설정은 tapflow init이 만들어 줍니다
아래에 보이는 `tunnel` 블록은 `tapflow init`을 실행하고 프로바이더를 고르면 대화형으로 생성됩니다. [tapflow 설정](/ko/operate/configure)을 참고하세요. 여기서는 생성된 설정과 프로바이더 쪽 준비 과정을 다룹니다.
:::

| | Tailscale | VPS + rathole |
|---|-----------|---------------|
| **설정** | 앱 설치 + 로그인 | SSH 접근 가능한 VPS 필요 |
| **비용** | 비상업용은 무료 Personal 플랜, 업무용은 유료 플랜 | VPS 운영 비용 |
| **접속 가능 대상** | Tailscale tailnet 멤버만 | URL을 아는 누구나 |
| **적합한 경우** | 내부 팀 | 외부 협력사, 공개 데모 |

## Tailscale (권장)

[Tailscale](https://tailscale.com)은 WireGuard 기반 제로 설정 VPN입니다. 포트 포워딩이나 공인 IP 없이 기기 간 암호화 오버레이 네트워크("tailnet")를 구성합니다.

```text
브라우저 (tailnet) ──[WireGuard E2E]──► 릴레이 Mac (tailnet)
                                               ↑
                                       에이전트 Mac (같은 내부 네트워크)
```

트래픽이 평문으로 팀 인프라를 벗어나지 않습니다. Tailscale의 DERP 릴레이를 폴백으로 사용하더라도 암호화된 WireGuard 패킷만 중계되며 Tailscale 서버도 복호화할 수 없습니다.

**사전 조건**: 릴레이 Mac과 접속할 브라우저 머신 모두에 Tailscale을 설치해야 합니다.

- [Tailscale 다운로드 →](https://tailscale.com/download) — macOS, Windows, Linux, iOS, Android
- 무료 Personal 플랜은 비상업용입니다. 팀이 업무에 쓰려면 비즈니스 플랜이 필요합니다 · [요금제 →](https://tailscale.com/pricing)

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

### HTTPS로 더 부드러운 스트림 켜기 (선택)

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

## VPS + rathole

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

### 1. VPS에 Caddy 설치

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

### 2. 릴레이 Mac에서 tapflow 설정

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
