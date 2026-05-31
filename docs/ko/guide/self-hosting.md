# 릴레이 배포

릴레이는 경량 Node.js 서버입니다. WebSocket 트래픽 라우팅과 대시보드 서빙만 담당하므로 무거운 컴퓨팅 자원이 필요하지 않습니다.

::: info 릴레이 URL은 두 가지 용도로 사용합니다
- **대시보드 접속**: 브라우저에서 `http://your-relay-url`로 접속하면 대시보드가 열립니다.
- **에이전트 연결**: `tapflow agent start --relay wss://your-relay-url`로 에이전트를 연결합니다.
:::

## 배포 시나리오

### 로컬 운영 (Mac 한 대)

릴레이와 에이전트를 같은 Mac에서 한 번에 실행합니다.

```sh
tapflow start
```

### 팀 운영 (릴레이 서버 분리)

릴레이는 전용 Mac에서, 에이전트는 시뮬레이터가 연결된 각 Mac에서 실행합니다.

::: tip 에이전트와 릴레이는 같은 내부 네트워크에 두세요
에이전트는 릴레이로 영상 프레임을 지속적으로 전송합니다. 층이 다르거나 VLAN이 분리돼 있어도 같은 사무실 건물 내 내부 네트워크라면 충분합니다. 에이전트를 인터넷 너머 다른 네트워크에 두면 RTT가 높아져 프레임 드롭이 발생합니다.
:::

**릴레이 Mac에서:**

```sh
tapflow relay start
```

**각 에이전트 Mac에서:**

```sh
tapflow agent start --relay wss://your-relay-url
```

## 배포 설정

### JWT_SECRET

::: warning 서버 배포 시 반드시 교체하세요
기본값(`tapflow-dev-secret-change-in-production`)이 소스코드에 공개되어 있습니다. 이 값을 그대로 사용하면 누구나 유효한 토큰을 위조할 수 있습니다.
:::

아래 명령으로 안전한 랜덤 시크릿을 생성합니다:

```sh
openssl rand -hex 32
```

생성된 값을 환경변수로 주입해 릴레이를 시작합니다:

```sh
JWT_SECRET=YOUR_JWT_SECRET tapflow relay start
```

한 번 설정한 후에는 값을 유지하세요. 변경하면 기존 세션이 즉시 모두 만료됩니다. 시크릿이 유출됐거나 의도적으로 전체 세션을 초기화할 때만 교체하면 됩니다.

### tapflow.config.json

릴레이는 현재 디렉토리에서 `tapflow.config.json`을 읽습니다. [설정 파일](/ko/reference/configuration)을 참고하세요.

## 내부 접속 (같은 네트워크)

같은 사무실 건물 내 팀원이 대시보드에 접근하는 가장 간단한 방법입니다.

```sh
npm install -g tapflow
JWT_SECRET=YOUR_JWT_SECRET tapflow relay start
```

팀원은 `http://MAC_LOCAL_IP:4000`으로 대시보드에 접속합니다. 포트는 `tapflow.config.json`의 `local.port` 값을 따릅니다 (기본값 `4000`).

## 외부 접속

릴레이와 에이전트는 항상 같은 내부 네트워크에 유지합니다. 외부 접속은 릴레이 Mac에서 외부로 아웃바운드 터널을 열어 브라우저가 공개 URL로 접근하도록 합니다.

### VPS + Tunnel (권장)

가장 안정적인 외부 접속 방법입니다. 트래픽이 팀 소유 VPS를 경유하므로 tapflow의 "데이터가 팀 인프라 안에" 원칙을 유지합니다.

```text
브라우저 → VPS (공개 URL) → 터널 → 릴레이 Mac (사무실)
                                      ↑
                                 에이전트 Mac (같은 내부 네트워크)
```

릴레이 Mac에서 VPS로 아웃바운드 터널을 열기 때문에 포트 포워딩이나 CGNAT 없이도 외부 접속이 가능합니다.

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

토큰을 환경변수로 전달하고 시작합니다:

```sh
TAPFLOW_TUNNEL_TOKEN=your-secret-token tapflow relay start
```

tapflow가 SSH로 VPS에 접속해 첫 실행 시 rathole을 자동으로 설치하고, VPS 서버와 로컬 클라이언트를 모두 실행합니다. 터널이 연결되면 배너에 공개 URL이 출력됩니다.

브라우저는 `https://your-vps.com`으로 접속하고, 에이전트는 릴레이의 내부 IP(`ws://192.168.x.x:4000`)로 연결합니다.

::: tip VPS 방화벽
VPS에서 `2333/tcp`(rathole)와 `443/tcp`(Caddy)를 열어야 합니다. `4000` 포트는 공개할 필요 없습니다 — Caddy가 내부에서 프록시합니다.
:::

::: danger 릴레이를 클라우드에 직접 배포하지 마세요
fly.io, Railway 등 클라우드 서비스에 릴레이를 올리면 에이전트→릴레이 구간이 인터넷을 타게 됩니다. 이 경우 RTT가 30fps 기준(33ms/frame)을 초과해 프레임 드롭이 발생하며 스트리밍 품질을 보장할 수 없습니다. tapflow는 이 구성을 지원하지 않습니다.
:::

## PM2 (릴레이 Mac 상시 운영)

릴레이 Mac에서 크래시 시 자동 재시작, 재부팅 후 자동 시작, 로그 관리를 처리합니다.

```sh
npm install -g pm2 tapflow
```

위에서 생성한 `JWT_SECRET`을 환경변수로 주입해 시작합니다:

```sh
JWT_SECRET=YOUR_JWT_SECRET pm2 start tapflow --name relay -- relay start
pm2 save
pm2 startup
```

tapflow를 업데이트할 때는:

```sh
npm update -g tapflow
pm2 restart relay
```

::: tip 다음 단계
릴레이가 실행되면 `tapflow init`으로 최초 관리자 계정을 생성합니다. 이후 팀원 초대와 첫 빌드 업로드는 [대시보드 최초 설정](/ko/dashboard/setup)을 참고하세요.
:::
