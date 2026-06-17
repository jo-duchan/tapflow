# tapflow 설정

`tapflow init`은 대화형으로 `tapflow.config.json`을 만들고, 자격 증명을 담는 `.env` 파일과 `.gitignore` 항목까지 함께 준비합니다. 기본값(포트 4000, 터널 없음, HTTP)으로 충분하다면 이 단계를 건너뛰고 바로 `tapflow start`로 넘어가도 됩니다.

## tapflow init 실행

릴레이를 실행할 디렉토리에서 실행합니다.

```sh
tapflow init
```

명령은 세 가지를 만듭니다.

| 생성물 | 내용 |
|--------|------|
| `tapflow.config.json` | 릴레이 설정 파일. 선택한 포트·터널·HTTPS 설정이 들어갑니다. |
| `.tapflow-data/.env` | DNS·ACME 자격 증명을 담는 파일. HTTPS 자동 발급을 선택했을 때만 만들어집니다. |
| `.gitignore` 항목 | `.tapflow-data/`를 추가해 런타임 데이터와 토큰이 커밋되지 않도록 합니다. |

이어서 대화형 프롬프트가 순서대로 나타납니다. 터널을 먼저 고르고, 터널 없이 LAN으로 쓸 때만 스트리밍 성능과 인증서 방식을 묻습니다.

```text
1. 터널 선택           None · Tailscale · rathole
2. 스트리밍 성능       터널이 None일 때만 — Standard(HTTP) · High(HTTPS)
3. 인증서 방식         High를 골랐을 때만 — DNS 자동 발급 · 직접 인증서
```

## 1. 터널 선택

팀원이 릴레이에 어떻게 접속하는지를 정합니다.

| 선택 | 의미 |
|------|------|
| **None** | 같은 LAN에서만 접속. 기본값입니다. |
| **Tailscale** | 암호화된 오버레이 네트워크로 외부 접속. VPS가 필요 없습니다. |
| **rathole** | 직접 보유한 VPS를 통해 완전한 공개 URL로 노출. |

각 터널의 설정 방법과 사전 준비물은 [릴레이 배포](/ko/guide/self-hosting#external-access)에서 다룹니다.

::: tip 비대화형 환경(CI)
프롬프트 없이 터널을 지정하려면 플래그를 씁니다. `tapflow init --tunnel tailscale` 또는 `tapflow init --tunnel rathole`. 이미 파일이 있으면 `--force`로 덮어씁니다.
:::

## 2. 스트리밍 성능 (LAN 전용)

터널을 **None**으로 골랐을 때만 나타나는 단계입니다. 같은 LAN의 팀원에게 어떤 화질로 스트리밍할지 정합니다.

| 선택 | 의미 |
|------|------|
| **Standard** | HTTP로 즉시 시작. 소프트웨어 디코드를 쓰며 도메인이 필요 없습니다. |
| **High performance** | HTTPS로 하드웨어 디코드(WebCodecs)를 켭니다. 더 부드럽지만 도메인이 필요합니다. |

브라우저의 하드웨어 디코드는 보안 컨텍스트(HTTPS)에서만 동작하므로, 더 선명하고 부드러운 화면을 주려면 **High performance**를 선택해 HTTPS를 설정합니다. 두 선택이 실제 화질·디코더로 어떻게 이어지는지는 [스트림 품질](/ko/guide/streaming)에서 설명합니다.

::: info 터널을 고르면 이 단계는 나오지 않습니다
Tailscale과 rathole은 HTTPS를 터널 계층에서 처리합니다. Tailscale은 자체 인증서를, rathole은 VPS의 Caddy가 TLS를 종단합니다. 따라서 LAN 직결일 때만 릴레이가 직접 HTTPS를 종단하도록 이 단계를 묻습니다.
:::

## 3. 인증서 방식 (High performance 선택 시)

HTTPS를 켜기로 했다면 인증서를 어떻게 마련할지 고릅니다.

| 선택 | 의미 |
|------|------|
| **DNS 자동 발급** | Cloudflare나 Vercel API 토큰으로 Let's Encrypt 인증서를 자동 발급·갱신합니다. 도메인을 입력하면 됩니다. |
| **직접 인증서(import)** | 사내 PKI나 이미 보유한 인증서 파일 경로를 지정합니다. 갱신은 직접 관리합니다. |

DNS 자동 발급을 고르면 업체를 선택하고 도메인을 입력합니다. 이때 토큰을 담을 `.tapflow-data/.env`가 함께 만들어집니다. 인증서 발급 모드와 설정 키의 전체 레퍼런스는 [설정 파일 — HTTPS](/ko/reference/configuration#https-보안-컨텍스트)에 있습니다.

## .tapflow-data/.env — 자격 증명 보관

DNS 자동 발급을 선택하면 `init`이 토큰을 담을 `.env` 파일을 빈 템플릿으로 만듭니다. 토큰은 비밀이라 `tapflow.config.json`에 두지 않고, gitignore되는 이 파일에 분리합니다.

만들어지는 파일은 키 이름만 있고 값은 비어 있습니다. 각 키의 `=` 뒤에 발급받은 토큰을 붙여넣습니다.

```ini
# tapflow DNS/ACME credentials — do not commit. Paste each token after the =.
TAPFLOW_CLOUDFLARE_TOKEN=
```

| 항목 | 내용 |
|------|------|
| 들어가는 값 | 선택한 DNS 업체의 API 토큰. Cloudflare는 `TAPFLOW_CLOUDFLARE_TOKEN`, Vercel은 `TAPFLOW_VERCEL_TOKEN`(팀 도메인은 `TAPFLOW_VERCEL_TEAM_ID`도) |
| 읽는 시점 | 릴레이가 시작할 때 읽어 인증서 발급에 사용합니다. |
| 권한 | 소유자만 읽도록 `0600`으로 생성됩니다. |
| 우선순위 | 셸 환경변수로 같은 키를 직접 설정하면 파일 값보다 우선합니다. |

이 방식 덕분에 릴레이를 재시작할 때마다 토큰을 다시 export할 필요가 없습니다. 파일에 한 번 넣어 두면 릴레이가 부팅할 때 알아서 읽습니다.

## 생성되는 파일

`tapflow init`을 마치면 작업 디렉토리는 다음과 같습니다.

```text
your-directory/
  tapflow.config.json    ← 릴레이 설정
  .gitignore             ← .tapflow-data/ 항목 추가됨
  .tapflow-data/
    .env                 ← DNS 자동 발급을 선택했을 때만
```

`tapflow.config.json`의 모든 키와 환경변수 오버라이드는 [설정 파일](/ko/reference/configuration)에서 자세히 다룹니다.

## 다음 단계

설정이 끝나면 릴레이와 에이전트를 시작합니다.

```sh
tapflow start
```

배포 시나리오별 시작 방법(단일 Mac, 분리 서버, 터널)은 [릴레이 배포](/ko/guide/self-hosting)를 참고하세요.
