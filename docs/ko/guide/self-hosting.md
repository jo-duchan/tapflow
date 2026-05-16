# 릴레이 서버 설정

릴레이는 경량 Node.js 서버입니다. WebSocket 트래픽 라우팅과 대시보드 서빙만 담당하므로 무거운 컴퓨팅 자원이 필요하지 않습니다.

::: info 릴레이 URL = 대시보드 URL
릴레이는 WebSocket, REST API와 함께 React 대시보드 SPA를 하나의 포트에서 서빙합니다. `http://your-server:4000`에 브라우저로 접속하면 바로 대시보드가 열립니다. 별도 웹 서버 설정이 필요 없습니다.
:::

## Docker Compose (권장)

프로덕션 환경에서는 Docker Compose를 사용하는 것이 가장 편리합니다.

```sh
git clone https://github.com/jo-duchan/tapflow.git
cd tapflow
```

프로젝트 루트에 `docker-compose.yml`을 작성합니다:

```yaml
services:
  tapflow:
    build: .
    ports:
      - "4000:4000"
    volumes:
      - ./tapflow-data:/app/.tapflow
    environment:
      JWT_SECRET: ${JWT_SECRET}
      TAPFLOW_PORT: 4000
    restart: unless-stopped
```

실행 전에 `JWT_SECRET`을 생성합니다:

```sh
# 안전한 랜덤 시크릿 생성
openssl rand -hex 32
```

생성된 값을 `.env` 파일이나 환경변수로 주입한 뒤 실행합니다:

```sh
JWT_SECRET=<생성된_값> docker compose up -d
```

::: warning JWT_SECRET은 반드시 교체하세요
기본값(`tapflow-dev-secret-change-in-production`)으로 프로덕션을 운영하면 누구나 유효한 토큰을 위조할 수 있습니다. 반드시 교체하세요.
:::

## Docker (단일 컨테이너)

```sh
git clone https://github.com/jo-duchan/tapflow.git
cd tapflow
docker build -t tapflow .
docker run -d \
  -p 4000:4000 \
  -v $(pwd)/tapflow-data:/app/.tapflow \
  -e JWT_SECRET=$(openssl rand -hex 32) \
  tapflow
```

컨테이너가 실행된 뒤 관리자 계정을 생성합니다:

```sh
tapflow init --relay http://your-server:4000
```

## 수동 설치 (Node.js)

```sh
npm install -g tapflow
tapflow relay start
```

릴레이는 현재 디렉토리에서 `tapflow.config.json`을 읽습니다. [설정 파일](/ko/reference/configuration)을 참고하세요.

실행 후 관리자 계정을 생성합니다:

```sh
tapflow init
```

## 데이터 디렉토리

릴레이는 모든 데이터를 `.tapflow/`에 저장합니다 (기본값):

```
.tapflow/
  db.sqlite         ← SQLite 데이터베이스
  uploads/
    builds/         ← .app.zip 및 .apk 파일
    avatars/
    comments/
```

이 디렉토리를 백업하면 모든 데이터가 보존됩니다.
