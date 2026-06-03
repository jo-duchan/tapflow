# 보안 및 개인정보

tapflow는 self-hosted 제품입니다. 빌드 파일, 기기 스트림, 세션 녹화물 — 모든 데이터가 여러분의 인프라 안에서만 움직입니다. 이 페이지는 tapflow가 설계상 어떻게 데이터를 보호하는지 설명합니다.

## 데이터는 네트워크를 벗어나지 않습니다

tapflow는 외부 클라우드 서비스를 경유하지 않습니다.

| 데이터 | 저장 위치 | 외부 전송 |
|--------|-----------|-----------|
| 빌드 파일 (.ipa / .apk) | relay가 실행 중인 Mac의 로컬 스토리지 | ❌ |
| 기기 스트림 (영상·터치) | 브라우저 ↔ relay ↔ agent — 모두 내부 | ❌ |
| 세션 녹화물 | relay 서버(Mac)에 저장, 72시간 후 자동 삭제 | ❌ |
| 로그 | relay와 agent가 실행 중인 Mac | ❌ |
| 계정·팀 정보 | relay의 SQLite DB (같은 Mac) | ❌ |

Appetize나 BrowserStack처럼 앱 바이너리를 외부 서버에 업로드할 필요가 없습니다. 바이너리는 여러분의 Mac에 머뭅니다.

## LAN 우선 아키텍처

tapflow의 권장 배포 구조는 agent와 relay가 **같은 LAN 안에 있는 것**입니다.

```text
브라우저 (어디서든) ──WAN──▶ relay ◀──LAN──▶ agent
                              │
                              └── SQLite DB, 빌드 파일
```

agent ↔ relay 구간은 LAN 내부 트래픽입니다. 기기 스트림이 외부 서비스를 경유하지 않으므로, 앱의 UI와 동작이 네트워크 밖으로 노출될 위험이 없습니다.

브라우저 ↔ relay 구간(WAN)에 TLS를 적용하려면 reverse proxy나 터널을 사용하세요. [릴레이 배포 가이드](/ko/guide/self-hosting)를 참고하세요.

## PAT 기반 인증

tapflow의 프로그래밍 방식 접근은 **Personal Access Token(PAT)** 으로 제어됩니다.

- PAT는 사용자별로 발급되며, 사용자가 떠나면 해당 토큰을 폐기합니다.
- 각 토큰에는 권한을 제한하는 **scope**가 있습니다.
  - `builds:write` — 빌드 업로드 (CI/CD 파이프라인용, 대시보드 Settings → Tokens에서 발급)
  - `view` — 조회 및 기기 스트림 접근
- 팀원의 대시보드 접근 권한은 PAT가 아니라 **역할**(role: Admin / Developer / QA / Viewer)로 별도 관리됩니다.

## 접근 제어 경계

tapflow가 제공하는 보호 범위와 여러분이 직접 관리해야 하는 범위는 다음과 같습니다.

**tapflow가 담당하는 것:**
- PAT 인증 및 scope 강제 적용
- 팀 간 세션 격리 (다른 팀의 빌드나 스트림에 접근 불가)
- 외부 서비스로의 데이터 전송 없음

**인프라 운영자가 담당해야 하는 것:**
- relay가 실행되는 Mac의 OS 및 네트워크 보안
- WAN 구간 TLS (reverse proxy 또는 터널 설정)
- relay 서버에 대한 네트워크 접근 제어 (방화벽, VPN 등)
- `tapflow.config.json`의 `jwtSecret` 등 환경 변수 관리

::: tip 내부 네트워크 전용으로 운영하는 경우
relay를 내부 LAN에서만 접근 가능하게 구성하면 WAN 구간 TLS 없이도 운영할 수 있습니다. 팀원 전체가 같은 네트워크(오피스 Wi-Fi, VPN)를 사용하는 경우에 적합합니다.
:::

## 취약점 제보

tapflow 코드에서 보안 문제를 발견했다면 공개 이슈 대신 비공개 채널로 제보해 주세요. 자세한 방법은 [SECURITY.md](https://github.com/jo-duchan/tapflow/blob/main/SECURITY.md)를 참고하세요.
