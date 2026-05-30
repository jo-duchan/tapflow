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

릴레이는 Linux 서버 또는 Mac에서, 에이전트는 시뮬레이터가 연결된 각 Mac에서 실행합니다.

::: tip 에이전트는 릴레이와 같은 LAN에 두세요
에이전트는 릴레이로 영상 프레임을 지속적으로 전송합니다. 최적의 스트리밍 품질을 위해 에이전트 Mac을 릴레이 서버와 같은 LAN에 두세요. 서로 다른 네트워크에 연결하면 레이턴시가 높아지고 프레임 드롭이 발생할 수 있습니다.
:::

**서버에서** (아래 PM2 또는 Node.js 방식 중 하나):

```sh
tapflow relay start
```

**각 Mac에서**:

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

## 내부 공유

같은 네트워크의 팀원이 대시보드에 접근하는 가장 간단한 방법입니다.

```sh
npm install -g tapflow
JWT_SECRET=YOUR_JWT_SECRET tapflow relay start
```

팀원은 `http://MAC_LOCAL_IP:4000`으로 대시보드에 접속합니다. 포트는 `tapflow.config.json`의 `server.port` 값을 따릅니다 (기본값 `4000`).

## 외부 공유

로컬 네트워크 밖에서 팀원이 대시보드에 접근하거나 에이전트가 다른 네트워크에서 연결하려면 외부 URL이 필요합니다.

### ngrok (빠른 시작)

도메인·서버 설정 없이 즉시 공개 URL을 얻는 가장 쉬운 방법입니다.

```sh
# 터미널 1: 릴레이 시작
tapflow relay start

# 터미널 2: ngrok으로 외부 URL 생성
ngrok http 4000
```

ngrok이 `https://abc123.ngrok-free.app` 형태의 URL을 출력합니다. 이 URL이 릴레이 주소이자 대시보드 주소입니다.

에이전트를 연결할 때는 `wss://` 스킴을 사용합니다:

```sh
tapflow agent start --relay wss://abc123.ngrok-free.app
```

::: warning ngrok 무료 플랜 제약
- 재시작할 때마다 URL이 바뀝니다 (고정 URL은 유료 플랜).
- 영상 스트림을 포함한 모든 트래픽이 ngrok 서버를 경유합니다. tapflow의 "데이터가 팀 인프라 안에" 원칙에 맞지 않습니다.
- **테스트·데모 용도**로만 사용하세요. 팀 운영 환경에서는 아래 리버스 프록시를 사용하세요.
:::

### nginx 예시

::: warning WebSocket upgrade 헤더 필수
`Upgrade`와 `Connection` 헤더가 없으면 에이전트의 WebSocket 연결이 실패합니다.
:::

```nginx
server {
    listen 443 ssl;
    server_name tapflow.myteam.example.com;

    ssl_certificate     /etc/letsencrypt/live/tapflow.myteam.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tapflow.myteam.example.com/privkey.pem;

    location / {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        proxy_read_timeout 3600s;
    }
}
```

### Caddy 예시

```
tapflow.myteam.example.com {
    reverse_proxy localhost:4000
}
```

Caddy는 TLS와 WebSocket 업그레이드를 자동으로 처리합니다.

## PM2 (서버 운영 권장)

크래시 시 자동 재시작, 서버 재부팅 후 자동 시작, 로그 관리를 처리합니다.

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
