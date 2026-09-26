---
title: 백업과 상시 운영
description: 릴레이의 데이터 디렉터리를 백업하고(SQLite는 Litestream) Mac에서는 PM2로, Linux에서는 systemd로 릴레이를 계속 실행합니다.
---

# 백업과 상시 운영

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

릴레이 시크릿은 `/etc/tapflow/relay.env`에 둡니다. 기존 [JWT_SECRET](/ko/operate/configure#jwt-secret) 섹션은 릴레이가 데이터 디렉터리에서 직접 읽는 `.env` 방식도 설명합니다:

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
