# 빌드 배포

CI에서 빌드를 올리면 팀 전체가 별도 도구 설치나 기기 세팅 없이 브라우저에서 바로 확인할 수 있습니다.

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

## 사전 조건

| 항목 | 설명 |
|------|------|
| tapflow relay | 실행 중이고 CI 환경에서 접근 가능해야 합니다 |
| Personal Access Token | **Settings → Tokens**에서 `builds:write` 권한으로 생성합니다 |

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
`.ipa` 파일은 지원하지 않습니다. `.app.zip`만 허용됩니다.  
`xcodebuild -sdk iphonesimulator`로 빌드한 뒤 `.app` 폴더를 zip으로 압축하세요.
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
