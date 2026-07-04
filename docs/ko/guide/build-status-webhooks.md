# 웹훅

팀이 리뷰를 마치고 빌드를 `Done` 또는 `Rejected`로 바꾸면, tapflow가 미리 등록해둔 URL로 그 사실을 알립니다. 이 신호를 Slack 알림이나 다음 배포 단계로 이어 붙이면 리뷰 결과가 자동으로 흐르게 됩니다.

EAS 웹훅이 빌드 완료를 알리는 것과는 방향이 다릅니다. tapflow는 빌드를 직접 만들지 않으므로, 여기서 알리는 것은 빌드 완료가 아니라 **사람이 내린 리뷰 판정**입니다.

## 동작 방식

```
팀원이 App Center에서 리뷰
  → 상태를 Done / Rejected 로 변경
  → tapflow가 등록된 URL로 POST (서명된 metadata)
  → 수신 측이 Slack 알림 · 다음 CI 단계로 연결
```

::: info 두 가지 테스트 경로
이 가이드는 **수동 리뷰 경로**를 다룹니다. CI가 빌드를 전달하고, 팀원이 직접 테스트하는 방식입니다.

LLM 에이전트가 시뮬레이터를 자동으로 조작하는 방식은 [CI/CD에서 MCP 활용](/ko/guide/mcp-ci)을 참고하세요. 이는 별도의 실험적 기능입니다.
:::

## 엔드포인트 등록

등록 방법은 두 가지입니다. 설정을 파일로 관리하면 `config.json`으로 선언하고, 런타임에 추가·삭제하려면 REST API를 씁니다. 두 방식으로 등록한 엔드포인트는 함께 발송됩니다.

### config.json으로 선언 (권장)

`tapflow.config.json`의 `webhooks` 배열에 등록합니다. self-hosted 운영자가 TLS·SMTP 같은 다른 설정과 한 파일에서 함께 관리하는 방식입니다.

```json
{
  "webhooks": [
    { "url": "https://ci.internal/hooks/tapflow", "secretEnv": "TAPFLOW_WEBHOOK_SECRET_CI" }
  ]
}
```

secret은 config.json에 직접 쓰지 않습니다. `secretEnv`에 환경 변수 이름을 지정하면 tapflow가 그 값을 서명 키로 읽어옵니다. 실제 secret은 `.env`에 둡니다.

```
TAPFLOW_WEBHOOK_SECRET_CI=a-long-random-string
```

| 필드 | 설명 |
|------|------|
| `url` | 알림을 받을 주소 (필수) |
| `secretEnv` | 서명 secret이 담긴 환경 변수 이름 (선택, 강하게 권장) |
| `enabled` | 활성 여부 (기본 `true`) |

config.json 변경은 relay를 다시 시작해야 반영됩니다.

### REST API로 등록

런타임에 추가하려면 `POST /api/v1/webhooks`를 씁니다. 인증은 빌드 업로드와 동일하게 `builds:write` 스코프의 Personal Access Token을 사용합니다. 토큰 발급은 [빌드 배포](/ko/guide/build-distribution)의 토큰 생성 절을 참고하세요.

```sh
curl -X POST https://your-relay/api/v1/webhooks \
  -H "Authorization: Bearer $TAPFLOW_PAT" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://ci.internal/hooks/tapflow","secret":"a-long-random-string"}'
```

| 필드 | 설명 |
|------|------|
| `url` | 알림을 받을 주소 (필수) |
| `secret` | 서명에 쓸 비밀 키 (선택, 강하게 권장) |
| `enabled` | 활성 여부 (기본 `true`) |

REST API는 `config.json`과 달리 secret을 요청 본문에 직접 담습니다. 여러 개를 등록하면 활성화된 모든 엔드포인트로 각각 전송되므로, Slack과 사내 CI에 동시에 연결할 수 있습니다.

REST 관리용 엔드포인트는 다음과 같습니다.

| Method | Path | 설명 |
|--------|------|------|
| `POST` | `/api/v1/webhooks` | 엔드포인트 등록 |
| `GET` | `/api/v1/webhooks` | 목록 조회 (`secret`은 노출되지 않음) |
| `PATCH` | `/api/v1/webhooks/:id` | `url` · `secret` · `enabled` 수정 |
| `DELETE` | `/api/v1/webhooks/:id` | 엔드포인트 삭제 |

## 페이로드

전송되는 본문은 다음 형태의 JSON입니다.

```json
{
  "event": "build.status_changed",
  "build": {
    "id": "42",
    "platform": "ios",
    "appVersion": "1.4.0",
    "status": "Done"
  },
  "changedAt": "2026-07-03T10:00:00.000Z"
}
```

| 필드 | 설명 |
|------|------|
| `event` | 이벤트 종류. 현재는 `build.status_changed` |
| `build.id` | 빌드 식별자 |
| `build.platform` | `ios` 또는 `android` |
| `build.appVersion` | 앱 버전. 없으면 `null` |
| `build.status` | `Done` 또는 `Rejected` |
| `changedAt` | 상태가 바뀐 시각 (ISO 8601) |

본문에는 빌드 식별 정보만 담기며, 앱 바이너리나 스크린 데이터는 포함되지 않습니다.

## 서명 검증

등록할 때 `secret`을 지정하면, tapflow는 본문을 그 비밀 키로 HMAC-SHA256 서명해 `X-Tapflow-Signature` 헤더에 담아 보냅니다. 값은 `sha256=` 접두사가 붙은 16진수입니다. 수신 측이 같은 비밀 키로 본문을 다시 서명해 두 값이 일치하는지 확인하면, 요청이 tapflow에서 왔으며 본문이 변조되지 않았음을 검증할 수 있습니다.

```js
import crypto from 'crypto'

function isFromTapflow(rawBody, signature, secret) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(signature ?? '')
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
```

서명 검증은 반드시 파싱 전의 원본 본문으로 해야 합니다. JSON으로 파싱한 뒤 다시 직렬화하면 바이트가 달라져 서명이 어긋납니다.

## 발화 조건

웹훅은 `status_label`이 `Done` 또는 `Rejected`로 **바뀔 때만** 전송됩니다.

- 이미 `Done`인 빌드를 다시 `Done`으로 두는 요청처럼 값이 그대로면 전송하지 않습니다.
- `Backlog`나 `In Progress`로의 변경, 상태 외 필드만 바뀐 변경도 전송하지 않습니다.
- 전송은 best-effort입니다. 수신 측이 응답하지 않거나 실패해도 빌드 상태 변경 자체는 정상 처리되며, 각 요청은 5초 후 시간 초과로 끊깁니다.

| 상태 | 의미 |
|------|------|
| `Done` | 이해관계자 승인 완료 |
| `Rejected` | 문제 발견, 수정 필요 |

## 보안

- 페이로드에는 metadata만 담기고 앱 바이너리는 전송되지 않습니다.
- 등록 URL은 loopback(`127.0.0.1`)과 클라우드 메타데이터 주소(`169.254.169.254`)를 거부합니다. 사내 사설망 주소(`10.x`, `192.168.x` 등)는 self-hosted CI를 위해 허용됩니다.
- `secret`은 선택이지만, 등록 URL이 노출되면 위조 요청이 들어올 수 있으므로 지정하기를 강하게 권장합니다.

## EAS 연동과의 관계

이 기능은 tapflow가 외부로 보내는(outbound) 알림입니다. 반대 방향인, EAS 빌드가 끝났을 때 그 결과를 받아 tapflow로 업로드하는(inbound) 방법은 [Expo 빌드 연동](/ko/guide/build-expo-eas)에서 다룹니다.
