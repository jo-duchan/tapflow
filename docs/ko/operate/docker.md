---
title: Docker로 배포
description: 상시 켜 둔 LAN 서버에서 공식 Docker 이미지로 릴레이를 실행합니다. Compose 파일, 필수 볼륨, 초대 링크용 릴레이 URL, 첫 계정 생성을 다룹니다.
---

# Docker Compose (LAN 서버)

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
