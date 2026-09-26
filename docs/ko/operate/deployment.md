---
title: 배포 방식 선택
description: 릴레이를 에이전트와 같은 Mac에서 실행할지 별도 릴레이 서버에 둘지 고르고 같은 네트워크의 팀원이 접속하는 방법을 확인합니다.
---

<a id="릴레이-배포"></a>

# 배포 방식 선택

릴레이는 경량 Node.js 서버입니다. WebSocket 트래픽 라우팅과 대시보드 서빙만 담당하므로 무거운 컴퓨팅 자원이 필요하지 않습니다.

::: info 릴레이 URL 두 가지 역할
- **대시보드 접속** — 브라우저에서 `http://localhost:4000` (로컬) 또는 `http://192.168.x.x:4000` (팀 내 접속)
- **에이전트 연결** — 릴레이가 다른 Mac에 있을 때: `tapflow agent start --relay ws://192.168.x.x:4000`. 에이전트→릴레이 구간은 LAN 내부로 연결합니다. 스킴은 `ws://`이고 릴레이에 `tls`를 설정해 HTTPS로 운영하면 `wss://`입니다. 원격 에이전트는 `agent` 스코프 토큰으로 인증합니다([원격 릴레이 인증](/ko/operate/agents#원격-릴레이-인증)).
:::

## 배포 시나리오

::: tip 에이전트와 릴레이는 같은 유선 LAN에 두세요
에이전트는 릴레이로 영상 프레임을 지속적으로 전송하므로 둘은 같은 LAN에 있어야 합니다. 같은 사무실 건물이라면 층이 다르거나 VLAN이 분리돼 있어도 내부 라우팅으로 지연이 충분히 낮습니다. 다만 에이전트를 인터넷 너머 다른 네트워크에 두면 RTT가 높아져 프레임이 드롭됩니다. **유선 이더넷을 권장합니다.** Wi-Fi도 동작하지만 Mac에서는 AWDL 때문에 끊길 수 있습니다. 끊김이 보이면 [스트림 지연·끊김](/ko/troubleshooting/streaming#stream-lag)을 참고하세요.
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

## 내부 접속 (같은 네트워크)

같은 사무실 건물 내 팀원이 대시보드에 접근하는 가장 간단한 방법입니다.

```sh
npm install -g tapflow
tapflow start
```

단일 릴레이는 `JWT_SECRET`을 자동 생성하므로 여기서 따로 설정할 값이 없습니다. 고정 키가 필요하면 [JWT_SECRET](/ko/operate/configure#jwt-secret)을 참고하세요.

팀원은 `http://MAC_LOCAL_IP:4000`으로 대시보드에 접속합니다. 포트는 `tapflow.config.json`의 `local.port` 값을 따릅니다 (기본값 `4000`).

## 옮겨진 섹션 {#moved-sections}

이 페이지에 있던 섹션은 아래 페이지로 옮겨졌습니다.

- [Docker로 배포](/ko/operate/docker)
  - <a id="docker-compose-lan-서버" data-moved-to="/ko/operate/docker#docker-compose-lan-서버"></a>[Docker로 배포](/ko/operate/docker#docker-compose-lan-서버)
- [tapflow 설정](/ko/operate/configure)
  - <a id="배포-설정" data-moved-to="/ko/operate/configure#배포-설정"></a>[배포 설정](/ko/operate/configure#배포-설정)
  - <a id="jwt-secret" data-moved-to="/ko/operate/configure#jwt-secret"></a>[JWT_SECRET](/ko/operate/configure#jwt-secret)
  - <a id="tapflow-config-json" data-moved-to="/ko/operate/configure#tapflow-config-json"></a>[tapflow.config.json](/ko/operate/configure#tapflow-config-json)
- [외부 접속](/ko/operate/external-access)
  - <a id="외부-접속" data-moved-to="/ko/operate/external-access#외부-접속"></a>[외부 접속](/ko/operate/external-access#외부-접속)
  - <a id="tailscale-권장" data-moved-to="/ko/operate/external-access#tailscale-권장"></a>[Tailscale (권장)](/ko/operate/external-access#tailscale-권장)
  - <a id="https로-더-부드러운-스트림-켜기-선택" data-moved-to="/ko/operate/external-access#https로-더-부드러운-스트림-켜기-선택"></a>[HTTPS로 더 부드러운 스트림 켜기 (선택)](/ko/operate/external-access#https로-더-부드러운-스트림-켜기-선택)
  - <a id="vps-rathole" data-moved-to="/ko/operate/external-access#vps-rathole"></a>[VPS + rathole](/ko/operate/external-access#vps-rathole)
  - <a id="_1-vps에-caddy-설치" data-moved-to="/ko/operate/external-access#_1-vps에-caddy-설치"></a>[1. VPS에 Caddy 설치](/ko/operate/external-access#_1-vps에-caddy-설치)
  - <a id="_2-릴레이-mac에서-tapflow-설정" data-moved-to="/ko/operate/external-access#_2-릴레이-mac에서-tapflow-설정"></a>[2. 릴레이 Mac에서 tapflow 설정](/ko/operate/external-access#_2-릴레이-mac에서-tapflow-설정)
- [백업과 상시 운영](/ko/operate/relay-operations)
  - <a id="백업" data-moved-to="/ko/operate/relay-operations#백업"></a>[백업](/ko/operate/relay-operations#백업)
  - <a id="권장-sqlite에는-litestream-사용" data-moved-to="/ko/operate/relay-operations#권장-sqlite에는-litestream-사용"></a>[권장: SQLite에는 Litestream 사용](/ko/operate/relay-operations#권장-sqlite에는-litestream-사용)
  - <a id="pm2-릴레이-mac-상시-운영" data-moved-to="/ko/operate/relay-operations#pm2-릴레이-mac-상시-운영"></a>[PM2 (릴레이 Mac 상시 운영)](/ko/operate/relay-operations#pm2-릴레이-mac-상시-운영)
  - <a id="systemd-linux-릴레이-서버" data-moved-to="/ko/operate/relay-operations#systemd-linux-릴레이-서버"></a>[systemd (Linux 릴레이 서버)](/ko/operate/relay-operations#systemd-linux-릴레이-서버)
