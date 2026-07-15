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

bundle ID, 버전, 빌드 번호는 업로드한 빌드에서 자동으로 추출되므로 따로 입력하지 않아도 됩니다.

### EAS 웹훅으로 업로드 자동화

위 curl은 수동 업로드입니다. EAS Build가 끝나는 시점에 자동으로 올리려면, 직접 호스팅하는 작은 수신 엔드포인트로 [EAS 웹훅](https://docs.expo.dev/eas/webhooks/)을 보내면 됩니다. tapflow는 EAS 웹훅을 직접 받지 않고 표준 멀티파트 업로드만 받으므로, 이 수신 엔드포인트가 둘을 잇습니다. 이벤트를 검증하고, 산출물을 내려받고, relay로 POST합니다.

```
EAS Build 완료
  → EAS 웹훅          → 수신 엔드포인트: 서명 검증 → 산출물 다운로드
                      → POST /api/v1/builds (tapflow relay)
  → App Center에 빌드 등장 → 팀 리뷰
  → 상태 → Done / Rejected → tapflow 웹훅 → Slack · 다음 배포 단계
```

간단한 수신 엔드포인트 예시입니다(Node).

```js
import express from 'express'
import crypto from 'crypto'

const app = express()
app.use(express.raw({ type: 'application/json' })) // EAS는 원본 본문에 서명한다

app.post('/eas', async (req, res) => {
  // 1. expo-signature 헤더 검증 (원본 본문의 HMAC-SHA1)
  const expected = 'sha1=' + crypto.createHmac('sha1', process.env.EAS_WEBHOOK_SECRET).update(req.body).digest('hex')
  const got = Buffer.from(req.get('expo-signature') ?? '')
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, Buffer.from(expected))) {
    return res.status(401).end()
  }

  const build = JSON.parse(req.body.toString())
  if (build.status !== 'finished') return res.status(200).end() // errored / canceled 무시

  // 2. 산출물 다운로드 (iOS .tar.gz / Android .apk)
  const artifact = await fetch(build.artifacts.applicationArchiveUrl).then((r) => r.arrayBuffer())
  const name = build.platform === 'ios' ? 'build.tar.gz' : 'build.apk'

  // 3. tapflow로 넘기기 — 위 curl과 동일한 멀티파트 업로드
  const form = new FormData()
  form.append('file', new Blob([artifact]), name)
  form.append('status', 'In Progress')
  const up = await fetch(`${process.env.TAPFLOW_RELAY_URL}/api/v1/builds`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TAPFLOW_PAT}` },
    body: form,
  })
  res.status(up.ok ? 200 : 502).end()
})

app.listen(3000)
```

양쪽에 같은 시크릿을 설정합니다. `eas webhook:create --event BUILD`에 넘긴 값을 수신 쪽에서 `EAS_WEBHOOK_SECRET`으로 읽습니다. 서명 방식의 방향에 주의하세요. EAS는 **HMAC-SHA1**(`expo-signature`)로 서명하는 반면, tapflow의 발신 웹훅은 HMAC-SHA256을 씁니다([웹훅](/ko/guide/build-status-webhooks) 참고).

서비스를 상시 띄우기 부담스럽다면, EAS 웹훅이 `repository_dispatch`로 GitHub Actions 실행을 트리거하고 워크플로가 다운로드와 POST를 대신하게 할 수도 있습니다. 같은 세 단계이고 상시 수신 서버가 필요 없습니다.

## 4. 팀이 브라우저에서 테스트

업로드된 빌드는 App Center에 나타납니다. 팀원은 브라우저에서 기기를 선택해 바로 실행합니다. 딥링크 확인, 화면 검수, API 연동 확인을 별도 설치 없이 진행합니다.

::: warning 시뮬레이터의 한계
시뮬레이터에서 돌아가는 빌드라 카메라, 생체 인증, 푸시 토큰처럼 실기기 하드웨어가 필요한 기능은 확인할 수 없습니다. 이런 항목은 여전히 실기기 QA가 필요합니다.
:::

토큰, GitHub Actions 예시, 빌드 상태값 등 전체 업로드 계약은 [빌드 배포](/ko/guide/build-distribution)에 정리돼 있습니다.
