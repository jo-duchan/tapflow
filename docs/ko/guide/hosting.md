# 셀프호스팅

팀원이 외부에서 대시보드에 접근하거나 에이전트가 다른 네트워크에서 릴레이에 연결할 때 필요합니다.

## ngrok (빠른 시작)

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

## HTTPS / 리버스 프록시

고정 도메인과 HTTPS가 필요한 팀 운영 환경에 적합합니다.

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
