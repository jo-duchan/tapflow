# 빌드 배포

CI 파이프라인을 연결하면 빌드가 App Center에 자동으로 등록되어 팀원 누구든 바로 확인할 수 있습니다.

## 동작 방식

```
CI 파이프라인
  → POST /api/v1/builds (tapflow relay)
  → App Center에 빌드 등록
  → 팀원이 브라우저에서 기기를 선택하고 직접 테스트
      PO / PM: 기획한 대로 나왔는지
      디자이너: 디자인 스펙에 맞는지
      백엔드: API 연동이 맞는지
      QA: 버그가 있는지
```

CI 잡이 빌드 파일을 업로드하면 누구나 별도 도구 설치나 기기 세팅 없이 브라우저에서 바로 테스트할 수 있습니다.

::: info 두 가지 테스트 경로
이 가이드는 **수동 리뷰 경로**를 다룹니다. CI가 빌드를 전달하고, 팀원이 직접 테스트하는 방식입니다.

LLM 에이전트가 시뮬레이터를 자동으로 조작하는 방식은 [CI/CD에서 MCP 활용](/ko/guide/mcp-ci)을 참고하세요. 이는 별도의 실험적 기능입니다.
:::

## 빌드 도구별 레시피

아래 단계는 어떤 빌드 도구에도 적용되는 범용 방식입니다. 특정 도구를 쓴다면 전용 레시피를 먼저 참고하세요.

| 빌드 도구 | 레시피 |
|-----------|--------|
| Expo (EAS) | [EAS 빌드 연동](/ko/guide/build-expo-eas) |
| bare React Native · Flutter · 네이티브 | 이 페이지의 범용 방식(빌드 → 산출물 → 업로드)을 그대로 따르세요 |

빌드에서 산출물(`.app.zip`·`.tar.gz`·`.apk`)만 나오면 그다음 과정은 빌드 도구와 무관하게 같습니다.

## 사전 조건

| 항목 | 설명 |
|------|------|
| tapflow relay | 실행 중이고 CI 환경에서 접근 가능해야 합니다 |
| Personal Access Token | **Settings → Tokens**에서 `builds:write` 권한으로 생성합니다 |

## CI가 relay에 도달하려면

CI 잡이 relay의 `POST /api/v1/builds`에 접근할 수 있어야 합니다. relay는 에이전트와 같은 내부 네트워크에 두는 것이 원칙입니다([릴레이 배포](/ko/guide/self-hosting)). 그래서 CI가 어디서 실행되는지에 따라 경로가 갈립니다.

| relay 배치 | CI가 업로드하는 방법 |
|-----------|----------------------|
| **LAN 전용 (기본)** | 클라우드 러너(GitHub 호스티드 등)는 LAN relay에 닿지 못합니다. 내부 네트워크에 둔 self-hosted 러너에서 relay 내부 주소(`http://192.168.x.x:4000`)로 업로드하세요 |
| **VPS + rathole 터널** | relay를 [외부 접근](/ko/guide/self-hosting)용으로 열어 두면 공개 URL(`https://your-vps.com`)로 어디서든 업로드할 수 있어 클라우드 CI에 가장 잘 맞습니다 |
| **Tailscale 터널** | tailnet 멤버만 접근할 수 있으므로 CI 러너도 tailnet에 연결돼 있어야 합니다 |

::: tip relay는 클라우드에 직접 올리지 않습니다
relay를 fly.io·Railway 같은 서비스에 직접 배포하면 에이전트→relay 구간이 인터넷을 타면서 스트림이 끊깁니다(미지원). 공개 접근이 필요하면 relay는 내부 네트워크에 둔 채 터널로 노출하세요. VPS는 relay 호스트가 아니라 터널 호스트입니다.
:::

## 1. 토큰 생성

대시보드의 **Settings → Tokens → New Token**에서 생성합니다.

- **Name**: `GitHub Actions`처럼 용도를 알 수 있는 이름
- **Scope**: `builds:write`
- **Expiry**: 선택 사항

토큰은 생성 시 한 번만 표시됩니다. CI 시크릿(예: `TAPFLOW_PAT`)으로 저장하세요.

## 2. 빌드 업로드

빌드 파일이 준비되면 `POST /api/v1/builds`를 호출합니다.

```sh
# iOS (.app.zip)
curl -X POST https://your-relay/api/v1/builds \
  -H "Authorization: Bearer $TAPFLOW_PAT" \
  -F "file=@MyApp.app.zip" \
  -F "status=In Progress" \
  -F "label=$GIT_BRANCH"

# Android (.apk)
curl -X POST https://your-relay/api/v1/builds \
  -H "Authorization: Bearer $TAPFLOW_PAT" \
  -F "file=@MyApp.apk" \
  -F "status=In Progress" \
  -F "label=$GIT_BRANCH"
```

`status=In Progress`는 팀에게 리뷰 준비가 됐다는 신호입니다.  
`label`에는 브랜치명, 티켓 번호 등 맥락을 담을 수 있습니다.

::: warning iOS 빌드
`.ipa` 파일은 지원하지 않습니다. 시뮬레이터 빌드는 `.app.zip` 또는 `.tar.gz`/`.tgz`를 올립니다. `.app.zip`은 `xcodebuild -sdk iphonesimulator`로 빌드해 `.app` 폴더를 zip으로 압축하고, `.tar.gz`는 [EAS 빌드 연동](/ko/guide/build-expo-eas)을 참고하세요.
:::

## 3. 빌드 메타데이터 첨부 (선택)

커밋과 브랜치 정보를 코멘트로 남기면 리뷰어가 무엇이 바뀌었는지 바로 확인할 수 있습니다.

```sh
BUILD_ID=$(curl -sf -X POST https://your-relay/api/v1/builds \
  -H "Authorization: Bearer $TAPFLOW_PAT" \
  -F "file=@MyApp.app.zip" \
  -F "status=In Progress" \
  -F "label=$GIT_BRANCH" | jq -r '.id')

curl -X POST https://your-relay/api/v1/comments \
  -H "Authorization: Bearer $TAPFLOW_PAT" \
  -F "build_id=$BUILD_ID" \
  -F "body=Branch: $GIT_BRANCH
Commit: $GIT_SHA
$GIT_COMMIT_MSG"
```

## GitHub Actions 예시

```yaml
name: tapflow에 업로드

on:
  push:
    branches: [main, 'release/**']
  pull_request:

jobs:
  upload:
    runs-on: macos-latest

    steps:
      - uses: actions/checkout@v4

      - name: 앱 빌드
        run: |
          xcodebuild -scheme MyApp -sdk iphonesimulator \
            -configuration Debug \
            CONFIGURATION_BUILD_DIR=build/Debug
          cd build/Debug && zip -r MyApp.app.zip MyApp.app

      - name: tapflow에 업로드
        env:
          TAPFLOW_PAT: ${{ secrets.TAPFLOW_PAT }}
          TAPFLOW_RELAY_URL: ${{ secrets.TAPFLOW_RELAY_URL }}
          BRANCH: ${{ github.head_ref || github.ref_name }}
          COMMIT: ${{ github.sha }}
          COMMIT_MSG: ${{ github.event.head_commit.message || github.event.pull_request.title }}
        run: |
          BUILD_RESPONSE=$(curl -sf -X POST "$TAPFLOW_RELAY_URL/api/v1/builds" \
            -H "Authorization: Bearer $TAPFLOW_PAT" \
            -F "file=@build/Debug/MyApp.app.zip" \
            -F "status=In Progress" \
            -F "label=$BRANCH")

          BUILD_ID=$(echo "$BUILD_RESPONSE" | jq -r '.id')

          COMMENT="Branch: $BRANCH"$'\n'"Commit: $COMMIT"$'\n'"$COMMIT_MSG"

          curl -sf -X POST "$TAPFLOW_RELAY_URL/api/v1/comments" \
            -H "Authorization: Bearer $TAPFLOW_PAT" \
            -F "build_id=$BUILD_ID" \
            -F "body=$COMMENT"
```

## 빌드 상태 참고

| 상태 | 의미 |
|------|------|
| `Backlog` | 업로드됐지만 아직 리뷰 준비 전 |
| `In Progress` | 준비 완료 — 팀이 테스트를 시작할 수 있음 |
| `Done` | 이해관계자 승인 완료 |
| `Rejected` | 문제 발견, 수정 필요 |

CI는 업로드 시 `In Progress`로 설정합니다. `Done`과 `Rejected`는 리뷰 후 팀원이 직접 변경합니다.
