# Expo 빌드 연동

tapflow는 프레임워크가 아니라 **빌드 산출물** 위에서 동작합니다. Expo 앱도 결국 React Native 앱입니다. 이 문서는 그중 EAS 빌드 경로를 다룹니다. Expo `eas build`로 만든 iOS 시뮬레이터 빌드는 `.tar.gz`로 나옵니다. tapflow는 이 포맷을 그대로 받으므로 다시 포장하거나 변환할 필요가 없습니다.

```
Expo / EAS
  → eas build (iOS 시뮬레이터 → .tar.gz · Android → .apk)
  → CI가 POST /api/v1/builds (tapflow relay)
  → App Center에 등록
  → 팀원이 브라우저에서 기기를 선택해 테스트
```

tapflow는 EAS를 대체하지 않습니다. EAS는 빌드·서명·배포를 담당합니다. tapflow는 빌드 **직후**에 끼어들어 팀원 전체가 설치 없이 결과를 확인하게 합니다. Metro(Fast Refresh) 개발 루프도 그대로 유지됩니다.

::: info 두 가지 테스트 경로
이 가이드는 **수동 리뷰 경로**를 다룹니다. CI가 빌드를 전달하고, 팀원이 직접 테스트하는 방식입니다.

LLM 에이전트가 시뮬레이터를 자동으로 조작하는 방식은 [CI/CD에서 MCP 활용](/ko/guide/mcp-ci)을 참고하세요. 이는 별도의 실험적 기능입니다.
:::

## 1. eas.json에 프로필 추가

시뮬레이터 빌드를 만드는 프로필을 하나 정의합니다.

```json
{
  "build": {
    "tapflow": {
      "ios": { "simulator": true },
      "android": { "buildType": "apk" }
    }
  }
}
```

iOS는 `simulator: true`가 핵심입니다. 이 옵션이 있어야 시뮬레이터에서 실행되는 빌드(`.tar.gz`)가 나옵니다. 기본 기기용 빌드는 `.ipa`라 시뮬레이터에서 실행되지 않습니다.

## 2. 빌드 생성

```sh
eas build --profile tapflow --platform all
```

iOS는 내부에 시뮬레이터 `.app`이 담긴 `.tar.gz`, Android는 `.apk`가 나옵니다. tapflow는 두 포맷을 그대로 받습니다.

## 3. tapflow에 업로드

빌드가 끝나면 산출물을 relay의 `POST /api/v1/builds`로 올립니다. CI에서 직접 빌드했다면 그 파일을, EAS 클라우드 빌드라면 완료 후 받은 산출물 URL에서 내려받아 업로드합니다.

먼저 `builds:write` 권한의 Personal Access Token을 준비합니다. 토큰 생성과 relay 주소를 정하는 방법은 [빌드 배포](/ko/guide/build-distribution)의 토큰 생성과 "CI가 relay에 도달하려면" 섹션에 있습니다.

```sh
curl -X POST "$TAPFLOW_RELAY_URL/api/v1/builds" \
  -H "Authorization: Bearer $TAPFLOW_PAT" \
  -F "file=@build.tar.gz" \
  -F "status=In Progress" \
  -F "label=$GIT_BRANCH"
```

bundle ID, 버전, 빌드 번호는 `.app` 안의 Info.plist에서 자동으로 추출되므로 따로 입력하지 않아도 됩니다.

EAS Build가 끝나는 시점에 자동으로 올리려면 작은 수신 엔드포인트를 하나 둡니다. EAS Webhook의 완료 알림을 받아 산출물 URL을 내려받은 뒤 위 요청을 그대로 호출하면 됩니다. tapflow는 이 표준 멀티파트 업로드를 받는 것까지 책임집니다.

## 4. 팀이 브라우저에서 테스트

업로드된 빌드는 App Center에 나타납니다. 팀원은 브라우저에서 기기를 선택해 바로 실행합니다. 딥링크 확인, 화면 검수, API 연동 확인을 별도 설치 없이 진행합니다.

::: warning 시뮬레이터의 한계
시뮬레이터에서 돌아가는 빌드라 카메라, 생체 인증, 푸시 토큰처럼 실기기 하드웨어가 필요한 기능은 확인할 수 없습니다. 이런 항목은 여전히 실기기 QA가 필요합니다.
:::

토큰, GitHub Actions 예시, 빌드 상태값 등 전체 업로드 계약은 [빌드 배포](/ko/guide/build-distribution)에 정리돼 있습니다.
