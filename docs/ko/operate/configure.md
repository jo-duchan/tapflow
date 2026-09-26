# tapflow 설정

`tapflow init`은 이 머신의 tapflow를 설정합니다. `tapflow.config.json`과 코딩 에이전트가 읽을 문서 파일을 쓰고, 선택에 따라 자격 증명 `.env`도 준비합니다. 기본값(포트 4000, 터널 없음, HTTP)으로 충분하다면 이 단계를 건너뛰고 바로 `tapflow start`로 넘어가도 됩니다.

## tapflow init 실행

어느 디렉터리에서 실행해도 됩니다. tapflow는 머신마다 설치 디렉터리 하나를 쓰고 기본값은 `~/.tapflow`입니다. 모든 명령이 같은 방식으로 그 디렉터리를 찾습니다.

```sh
tapflow init
```

명령은 설치 디렉터리 안에 최대 다섯 가지를 만듭니다.

| 생성물 | 내용 |
|--------|------|
| `tapflow.config.json` | 릴레이 설정 파일. 선택한 포트·터널·HTTPS 설정과 데이터 디렉터리, 이 머신 에이전트의 Lean mode가 들어갑니다. |
| `AGENTS.md` | 코딩 에이전트용 tapflow 섹션. `<!-- tapflow:begin -->` 마커 사이에 들어가고, 마커 밖에 쓴 내용은 `init`을 다시 실행해도 그대로 남습니다. |
| `CLAUDE.md` | Claude Code용 `@AGENTS.md` 한 줄. 설치 디렉터리가 tapflow 전용일 때만 만듭니다. 앱 저장소처럼 다른 용도가 섞인 디렉터리에 CLAUDE.md가 생기면, Claude Code가 그 저장소의 다른 `AGENTS.md`를 읽지 않게 됩니다. |
| `data/.env` | DNS·ACME 자격 증명을 담는 파일. DNS 자동 발급을 선택했을 때만 만들어집니다. |
| `.gitignore` 항목 | 설치 디렉터리가 git 저장소 안이면 데이터 디렉터리와 `/.tapflow/artifacts/`를 추가해 런타임 데이터와 토큰이 커밋되지 않도록 합니다(`.tapflow/flows/`는 추적 유지). |

`init`을 다시 실행하면 설정은 그대로 두고 `AGENTS.md`의 tapflow 섹션만 갱신합니다. 설정을 새로 만들려면 `--force`를 씁니다.

이어서 대화형 프롬프트가 순서대로 나타납니다. 터널을 먼저 고르고, 터널 없이 LAN으로 쓸 때만 스트리밍 성능과 인증서 방식을 묻습니다. Lean mode는 가볍게 만들 시뮬레이터나 에뮬레이터가 있는 환경에서만 묻습니다.

```text
1. 터널 선택           None · Tailscale · rathole
2. 스트리밍 성능       터널이 None일 때만 — Standard(HTTP) · Smooth(HTTPS)
3. 인증서 방식         Smooth를 골랐을 때만 — DNS 자동 발급 · 직접 인증서
4. Lean mode           Mac 또는 adb가 설치된 환경에서만 — Off · On
```

## 1. 터널 선택

팀원이 릴레이에 어떻게 접속하는지를 정합니다.

| 선택 | 의미 |
|------|------|
| **None** | 같은 LAN에서만 접속. 기본값입니다. |
| **Tailscale** | 암호화된 오버레이 네트워크로 외부 접속. VPS가 필요 없습니다. |
| **rathole** | 직접 보유한 VPS를 통해 완전한 공개 URL로 노출. |

각 터널의 설정 방법과 사전 준비물은 [외부 접속](/ko/operate/external-access)에서 다룹니다.

::: tip 비대화형 환경(CI)
프롬프트 없이 터널을 지정하려면 플래그를 씁니다. `tapflow init --tunnel tailscale` 또는 `tapflow init --tunnel rathole`. 이미 설정이 있으면 `--force`로 덮어씁니다. `--force` 없이 `--tunnel`을 주면 플래그를 무시하지 않고 멈춥니다. `--tunnel rathole`은 `tunnel.serverAddr`과 `tunnel.publicUrl`을 빈 값으로 씁니다. 두 값을 채우기 전에는 설정 검증에 실패해 모든 `tapflow` 명령이 종료되므로 바로 `tapflow.config.json`에서 채우세요.
:::

## 2. 스트리밍 성능 (LAN 전용)

터널을 **None**으로 골랐을 때만 나타나는 단계입니다. 같은 LAN의 팀원에게 어떤 화질로 스트리밍할지 정합니다.

| 선택 | 의미 |
|------|------|
| **Standard** | HTTP로 즉시 시작. 소프트웨어 디코드를 쓰며 도메인이 필요 없습니다. |
| **Smooth** | HTTPS로 하드웨어 디코드(WebCodecs)를 켭니다. 더 부드럽지만 도메인이 필요합니다. |

브라우저의 하드웨어 디코드는 보안 컨텍스트(HTTPS)에서만 동작하므로, 더 부드럽고 반응이 빠른 화면을 주려면 **Smooth**를 선택해 HTTPS를 설정합니다. 두 선택이 실제 화질·디코더로 어떻게 이어지는지는 [스트림 품질](/ko/operate/streaming-quality)에서 설명합니다.

::: info 터널을 고르면 이 단계는 나오지 않습니다
터널은 HTTPS를 터널 계층에서 처리하므로 이 단계는 LAN 직결일 때만 나옵니다. rathole은 VPS의 Caddy가, Tailscale은 `tailscale serve`(무료·선택)가 TLS를 종단하며, 릴레이의 `tls` 설정은 어느 쪽도 필요 없습니다. 터널별 HTTPS 설정은 [외부 접속](/ko/operate/external-access)을 참고하세요.
:::

## 3. 인증서 방식 (Smooth 선택 시)

HTTPS를 켜기로 했다면 인증서를 어떻게 마련할지 고릅니다.

| 선택 | 의미 |
|------|------|
| **DNS 자동 발급** | Cloudflare나 Vercel API 토큰으로 Let's Encrypt 인증서를 자동 발급·갱신합니다. 도메인을 입력하면 됩니다. |
| **직접 인증서(import)** | 사내 PKI나 이미 보유한 인증서 파일 경로를 지정합니다. 갱신은 직접 관리합니다. |

DNS 자동 발급을 고르면 업체를 선택하고 도메인을 입력합니다. 이때 토큰을 담을 `.tapflow/data/.env`가 함께 만들어집니다. 인증서 발급 모드와 설정 키의 전체 레퍼런스는 [설정 파일 — HTTPS](/ko/reference/configuration#https-보안-컨텍스트)에 있습니다.

## 4. Lean mode

에이전트가 부팅하는 시뮬레이터와 에뮬레이터를 가볍게 돌릴지 정합니다.

| 선택 | 의미 |
|------|------|
| **Off** | 시뮬레이터가 모든 백그라운드 서비스를 실행합니다. 기본값입니다. |
| **On** | iOS에서는 tapflow가 시뮬레이터를 실행하는 동안 정해진 목록의 백그라운드 서비스를 끕니다. iOS 27에서 재 보면 시뮬레이터 한 대의 메모리가 4분의 1 정도 줄어듭니다. Android에서는 Google 번들 앱 네 개를 비활성화해 둡니다. API 34에서 재 보면 에뮬레이터 한 대의 메모리가 5분의 1이 조금 안 되게 줄어듭니다. |

선택한 값은 `tapflow.config.json`의 `agent.lean`에 저장되고 나중에 그 파일에서 바꿀 수 있습니다. 무엇이 꺼지고 무엇이 켜져 있는지, 언제 적용되는지는 [설정 파일 — Lean mode](/ko/reference/configuration#lean-mode-에이전트)에 정리돼 있습니다.

## 데이터 디렉터리의 .env — 비밀 보관 {#데이터-디렉토리의-env-—-비밀-보관}

`<데이터 디렉터리>/.env`는 릴레이의 **모든 비밀이 모이는 기본 경로**입니다. 기본 설치라면 `~/.tapflow/data/.env`입니다. DNS 자동 발급을 선택하면 `init`이 토큰을 담을 빈 템플릿을 만들지만, 이 파일에는 DNS 토큰뿐 아니라 `JWT_SECRET`이나 SMTP 비밀번호 같은 다른 비밀도 한 줄씩 적을 수 있습니다. 비밀이라 `tapflow.config.json`에 두지 않고, gitignore되는 이 파일에 분리합니다.

`init`이 만든 파일에는 선택한 DNS 공급자의 토큰 줄만 들어 있습니다. 다른 비밀은 아래 예시처럼 줄을 추가하고 키 이름 뒤 `=` 다음에 값을 붙여넣습니다.

```ini
# tapflow secrets — do not commit. Paste each value after the =.
TAPFLOW_CLOUDFLARE_TOKEN=
JWT_SECRET=
SMTP_PASS=
```

| 항목 | 내용 |
|------|------|
| 들어가는 값 | 어떤 릴레이 비밀이든 — DNS 업체 토큰(`TAPFLOW_CLOUDFLARE_TOKEN`·`TAPFLOW_VERCEL_TOKEN`), `JWT_SECRET`, `SMTP_PASS` 등 |
| 읽는 시점 | 릴레이가 시작할 때 가장 먼저 읽어 이후 모든 설정에 반영합니다. |
| 권한 | 소유자만 읽도록 `0600`으로 생성됩니다. |
| 우선순위 | **셸 환경변수 > `.env` > `tapflow.config.json`** 순입니다. 셸에 같은 키를 직접 설정하면 파일 값보다 우선합니다. |

단 `TAPFLOW_DATA_DIR`만 예외입니다. 이 값이 `.env`의 위치(`<dataDir>/.env`)를 결정하므로 `.env` 안에 적어도 읽히지 않습니다. 데이터 디렉터리는 `tapflow.config.json`이나 셸 환경변수로만 바꿉니다.

이 방식 덕분에 릴레이를 재시작할 때마다 비밀을 다시 export할 필요가 없습니다. 파일에 한 번 넣어 두면 릴레이가 부팅할 때 알아서 읽습니다. PM2나 launchd로 상시 운영할 때 특히 편합니다.

## 생성되는 파일

`tapflow init`을 마치면 설치 디렉터리는 다음과 같습니다.

```text
~/.tapflow/
  tapflow.config.json    ← 릴레이 설정
  AGENTS.md              ← 코딩 에이전트용 tapflow 섹션
  CLAUDE.md              ← @AGENTS.md
  data/                  ← 릴레이 런타임 상태: db, 업로드, 비밀
    .env                 ← DNS 자동 발급을 선택했을 때만
```

`data/`는 릴레이가 첫 시작 때 채웁니다.

## 무엇이 어디에 있나

플로우 파일은 설치의 일부가 아닙니다. 테스트 대상 코드 옆, 앱 저장소에 둡니다.

```text
~/.tapflow/              ← 이 머신: 설치 하나, 어디서 실행하든 같은 곳
  tapflow.config.json
  data/                  ← DB, 업로드된 빌드, 비밀

your-app/                ← 앱 저장소: 리뷰하고 커밋하고 CI에서 실행
  .tapflow/
    flows/               ← 커밋하는 플로우 YAML
    artifacts/           ← `tapflow flow run`의 실패 스크린샷 (gitignore)
```

둘을 가르는 기준은 복구 방법입니다. 저장소 쪽은 `git clone`으로 돌아오고, 머신 쪽은 백업에서 복원합니다. DB와 업로드된 빌드, 서명 키는 커밋할 수 없기 때문입니다. 게다가 플로우 파일은 저장소에 있어야 CI가 실행할 수 있습니다. 러너는 앱 저장소를 checkout하지 홈 디렉터리를 받지 않습니다.

용량이 커지는 쪽은 업로드된 빌드입니다. Mac에서는 홈 디렉터리 안이라 Time Machine 백업에도 함께 들어갑니다. 다른 곳에 두려면 `TAPFLOW_HOME`을 설정하세요. 서버라면 [systemd 예시](/ko/operate/relay-operations#systemd-linux-릴레이-서버)처럼 `/var/lib/tapflow`를 씁니다.

## 명령이 쓰는 설치 디렉터리 {#명령이-쓰는-설치-디렉토리}

모든 명령이 같은 순서로 찾습니다.

| | 설치 디렉터리 |
|---|---|
| `TAPFLOW_HOME`이 설정됨 | 그 디렉터리 |
| 현재 디렉터리가 이미 설치임. `tapflow.config.json`이 있거나, 데이터가 든 `.tapflow/data` 또는 `.tapflow-data`가 있음 | 현재 디렉터리 |
| 그 외 | `~/.tapflow` |

두 번째 규칙 덕분에 홈 디렉터리 방식이 생기기 전에 만든 설치가 있던 자리에서 그대로 돕니다. `tapflow start`와 `tapflow relay start`는 설치 디렉터리, 설정 파일, 데이터 디렉터리를 시작할 때 출력하므로 어느 설치를 쓰는지 항상 확인할 수 있습니다.

서버나 두 번째 설치에는 `TAPFLOW_HOME`을 씁니다. `TAPFLOW_HOME=/var/lib/tapflow tapflow init`은 그 디렉터리를 만들고, 같은 변수를 가진 이후 명령이 모두 그 설치를 씁니다. 없는 디렉터리를 가리키면 릴레이를 실행하는 명령과 `agent start`, `status`, `logs`, `admin init`이 멈춥니다. 다른 자리에 빈 설치를 조용히 만들지 않습니다.

새 설치의 데이터는 `<설치>/data`에 있습니다. 이미 `.tapflow/data`나 `.tapflow-data`가 있는 설치는 그대로 읽고, `init`이 찾은 경로를 `local.dataDir`에 적어 두므로 나중에 레이아웃이 바뀌지 않습니다.

`tapflow.config.json`의 모든 키와 환경변수 오버라이드는 [설정 파일](/ko/reference/configuration)에서 자세히 다룹니다.

## 코딩 에이전트에게 tapflow 묻기

`init`은 설치 디렉터리의 `AGENTS.md`에 `<!-- tapflow:begin -->`과 `<!-- tapflow:end -->` 사이로 tapflow 섹션을 씁니다. 기억이 아니라 [문서 목차](https://www.tapflow.dev/llms.txt)를 근거로 답하라는 것, 각 페이지를 마크다운으로 읽는 방법, 이 설치의 비밀이 어느 파일에 있는지, `tapflow --version`과 CHANGELOG를 대조하라는 것이 들어갑니다. 그 디렉터리에서 코딩 에이전트를 열면(`cd ~/.tapflow`) 설정 파일을 읽고 `tapflow doctor`, `tapflow status`, `tapflow logs`도 직접 돌려 볼 수 있습니다.

직접 쓴 내용은 마커 밖에 두세요. `init`은 마커 사이만 교체합니다.

Claude Code는 `AGENTS.md`를 직접 읽습니다. 읽지 못하는 세션(구버전, Amazon Bedrock 같은 서드파티 제공자, 텔레메트리를 끈 경우)은 `CLAUDE.md`를 읽기 때문에 `init`이 `@AGENTS.md` 한 줄을 담은 파일을 만듭니다. 설치 디렉터리에 이미 `CLAUDE.md`가 있으면 그 줄을 직접 추가하세요. `init`은 직접 쓴 파일을 고치지 않고 안내만 합니다.

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

## 다음 단계

설정이 끝나면 릴레이와 에이전트를 시작합니다.

```sh
tapflow start
```

배포 시나리오별 시작 방법(단일 Mac, 분리 서버, 터널)은 [배포 방식 선택](/ko/operate/deployment)을 참고하세요.
