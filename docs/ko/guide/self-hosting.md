# 릴레이 배포

릴레이는 경량 Node.js 서버입니다. WebSocket 트래픽 라우팅과 대시보드 서빙만 담당하므로 무거운 컴퓨팅 자원이 필요하지 않습니다.

::: info 릴레이 URL = 대시보드 URL
릴레이는 WebSocket, REST API와 함께 React 대시보드 SPA를 하나의 포트에서 서빙합니다. `http://your-server:4000`에 브라우저로 접속하면 바로 대시보드가 열립니다. 별도 웹 서버 설정이 필요 없습니다.
:::

## 배포 시나리오

### 로컬 운영 (Mac 한 대)

릴레이와 에이전트를 같은 Mac에서 한 번에 실행합니다.

```sh
tapflow start
```

### 팀 운영 (릴레이 서버 분리)

릴레이는 Linux 서버 또는 Mac에서, 에이전트는 시뮬레이터가 연결된 각 Mac에서 실행합니다.

**서버에서** (아래 PM2 또는 Node.js 방식 중 하나):

```sh
tapflow relay start
```

**각 Mac에서**:

```sh
tapflow agent start --relay wss://your-relay-url
```

## 로컬 설치 (Node.js)

```sh
npm install -g tapflow
tapflow relay start
```

릴레이는 현재 디렉토리에서 `tapflow.config.json`을 읽습니다. [설정 파일](/ko/reference/configuration)을 참고하세요.

## JWT_SECRET 설정

::: warning 서버 배포 시 반드시 교체하세요
기본값(`tapflow-dev-secret-change-in-production`)이 소스코드에 공개되어 있습니다. 이 값을 그대로 사용하면 누구나 유효한 토큰을 위조할 수 있습니다.
:::

아래 명령으로 안전한 랜덤 시크릿을 생성합니다:

```sh
openssl rand -hex 32
```

생성된 값을 환경변수로 주입합니다:

```sh
# Node.js
JWT_SECRET=<생성된_값> tapflow relay start

# PM2
JWT_SECRET=<생성된_값> pm2 start tapflow --name relay -- relay start
```

## PM2 (서버 운영 권장)

서버에서 릴레이를 안정적으로 운영할 때 권장합니다. 크래시 시 자동 재시작, 서버 재부팅 후 자동 시작, 로그 관리를 처리합니다.

```sh
npm install -g pm2 tapflow
```

위에서 생성한 `JWT_SECRET`을 환경변수로 주입해 시작합니다:

```sh
JWT_SECRET=<생성된_값> pm2 start tapflow --name relay -- relay start
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

## 외부 공유

위 방식 중 어느 것으로 릴레이를 실행하든, 로컬호스트 밖에서 팀원이 접근하거나 에이전트가 다른 네트워크에서 연결하려면 외부 URL이 필요합니다.

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

