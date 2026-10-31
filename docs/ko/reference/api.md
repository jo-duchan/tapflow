---
title: REST API
description: "tapflow REST API 전체 레퍼런스(/api/v1): 인증, 초대, 비밀번호 재설정, 앱, 빌드, 코멘트, 팀, 토큰, 프로필, 설정, 녹화, 실행 기록, 에이전트, 세션, 릴레이, 로그의 요청과 응답 형식."
---

# REST API

모든 엔드포인트는 릴레이의 `http(s)://<relay-host>/api/v1/`에서 제공됩니다.

**인증 방식**
- 대시보드 사용자: 세션 쿠키 (`tapflow_token`, 로그인 시 자동 설정)
- CI/CD 스크립트: `Authorization: Bearer tflw_pat_<token>` 헤더

아래 엔드포인트만 개인 액세스 토큰(PAT)을 받으며 세션 쿠키로도 호출할 수 있습니다.

| PAT scope | 엔드포인트 |
|-----------|-----------|
| `builds:write` | `POST /builds`, `GET /builds`, `GET /builds/:id`, `POST /comments`, 웹훅 엔드포인트 전체, 실행 기록 쓰기(`POST /runs` 아래) |
| `view` | `GET /apps`, `GET /runs` 아래, `GET /sessions/:sessionId/screenshot`, `GET /sessions/:sessionId/ui-tree`, `/uploads/` 아래 파일(`/api/v1/`이 아닌 릴레이 루트 경로), 원격에서 여는 기기 세션 WebSocket |
| `agent` | 원격 에이전트의 WebSocket 연결. 토큰을 발급한 팀원이 Admin인 동안에만 받습니다 |

**역할.** PAT로 호출해도 토큰 주인의 현재 역할이 적용됩니다. Viewer는 읽기 전용이라 빌드 업로드·수정·삭제 예약, 앱 생성·수정·삭제, 웹훅 엔드포인트 전체, 실행 기록 쓰기에서 `403`을 받습니다. 빌드 조회와 댓글 작성은 Viewer도 할 수 있습니다. 역할을 확인하는 엔드포인트는 요청마다 역할을 다시 읽으므로 역할을 바꾸면 다시 로그인하거나 토큰을 새로 만들지 않아도 바로 적용됩니다.


## 에러 응답

모든 에러는 `{ "error": "..." }` 형태의 JSON을 반환합니다.

| 상태 코드 | 의미 | 예시 |
|---------|------|------|
| `400` | 잘못된 요청 (필드 누락, 형식 오류 등) | `{ "error": "file required" }` |
| `401` | 인증 없음 또는 만료 | `{ "error": "Unauthorized" }` |
| `403` | 권한 없음 | `{ "error": "Forbidden" }`, `{ "error": "Insufficient scope" }` 또는 `{ "error": "Viewers have read-only access" }` |
| `404` | 리소스를 찾을 수 없음 | `{ "error": "Build not found" }` |
| `409` | 현재 상태에서 처리할 수 없음 | `{ "error": "Device is not booted" }` |
| `410` | 토큰 만료 | `{ "error": "Invitation expired or not found" }` |
| `429` | 요청이 너무 많음 (`Retry-After` 헤더 포함) | `{ "error": "Too many attempts. Try again later." }` |
| `500` | 서버 오류 | `{ "error": "Internal server error" }` |
| `502` | 에이전트에 연결할 수 없거나 에이전트가 오류를 반환함 | `{ "error": "Agent offline" }` |
| `504` | 에이전트 응답 시간 초과 | `{ "error": "Screenshot timed out" }` |

댓글·멤버·토큰 삭제는 성공하면 `204`를 본문 없이 반환합니다. 앱·웹훅 삭제와 빌드 삭제 예약 취소는 `200 { "ok": true }`를 반환합니다.


## 인증 (Auth)

### `GET /api/v1/auth/status`

릴레이에 관리자 계정이 있는지 알려 줍니다. 인증이 필요 없습니다.

**응답 `200`**

```json
{ "initialized": false, "canInitialize": true }
```

`canInitialize`는 계정이 하나도 없고 이 요청으로 첫 계정을 만들 수 있을 때 `true`입니다. 첫 계정은 릴레이 호스트에서 온 요청만 만들 수 있습니다. 설정 페이지는 이 값을 보고 폼 대신 `tapflow admin init` 안내를 띄웁니다.

### `POST /api/v1/auth/init`

최초 관리자 계정을 생성합니다. 계정이 하나도 없을 때만 사용 가능합니다.

```
Body (JSON):
  email     string  필수
  password  string  필수 (최소 8자)
```

**응답 `201`**

```json
{ "ok": true }
```

계정이 이미 존재하면 `403 { "error": "Already initialized" }`를 반환합니다. 요청이 릴레이 호스트에서 오지 않았으면 `tapflow admin init`을 안내하는 오류와 함께 `403`을 반환합니다.


### `POST /api/v1/auth/login`

로그인합니다. 성공 시 `tapflow_token` 쿠키가 설정됩니다 (7일 유효).

```
Body (JSON):
  email     string  필수
  password  string  필수
```

**응답 `200`**

```json
{ "ok": true, "role": "Admin" }
```

이메일은 대소문자와 앞뒤 공백을 구분하지 않고 비교합니다. 같은 주소와 이메일로 로그인에 계속 실패하면 `429`와 `Retry-After` 헤더를 반환합니다.


### `POST /api/v1/auth/logout`

로그아웃합니다. 쿠키를 삭제합니다.

**응답 `200`**

```json
{ "ok": true }
```


### `GET /api/v1/auth/me`

현재 로그인한 사용자 정보를 반환합니다.

**응답 `200`**

```json
{
  "id": 1,
  "email": "admin@example.com",
  "displayName": "Admin",
  "avatarUrl": "/uploads/avatars/user-1.png",
  "role": "Admin"
}
```

`avatarUrl`은 프로필 이미지가 없으면 `null`입니다.


### `POST /api/v1/auth/change-password`

비밀번호를 변경합니다.

```
Body (JSON):
  currentPassword  string  필수
  newPassword      string  필수 (최소 8자)
```

**응답 `200`**

```json
{ "ok": true }
```

응답에 새 `tapflow_token` 쿠키가 설정됩니다. 비밀번호를 바꾸면 다른 모든 브라우저에서 로그아웃되고 열려 있던 연결도 끊깁니다.


## 초대 (Invitations)

### `GET /api/v1/invitations/verify`

초대 토큰의 유효 여부를 확인합니다.

```
Query:
  token  string  필수 (64자 hex)
```

**응답 `200`**

```json
{ "role": "QA" }
```

만료되었거나 존재하지 않으면 `410`을 반환합니다.


### `POST /api/v1/invitations/accept`

초대를 수락하고 계정을 생성합니다. 성공 시 로그인 쿠키가 설정됩니다. 초대받은 이메일로 이미 계정이 있으면 `409`를 반환합니다. 초대로 기존 계정이 바뀌는 일은 없습니다.

```
Content-Type: multipart/form-data

Fields:
  token         string  필수
  password      string  필수 (최소 8자)
  display_name  string  선택
File:
  avatar        이미지 (PNG/JPEG, 최대 2MB) — 선택
```

**응답 `200`**

```json
{ "ok": true }
```


## 비밀번호 재설정

### `GET /api/v1/auth/reset-password/verify`

비밀번호 재설정 토큰의 유효 여부를 확인합니다.

```
Query:
  token  string  필수
```

**응답 `200`**

```json
{ "ok": true }
```

재설정 토큰은 발급 후 2시간 동안 유효합니다. 만료되었으면 `410`을 반환합니다.


### `POST /api/v1/auth/reset-password`

비밀번호를 재설정합니다.

```
Body (JSON):
  token     string  필수
  password  string  필수 (최소 8자)
```

**응답 `200`**

```json
{ "ok": true }
```

모든 브라우저에서 로그아웃되며 새 비밀번호로 다시 로그인해야 합니다. 그 사용자의 개인 액세스 토큰은 모두 폐기되고 그 토큰으로 연결된 에이전트도 끊기므로 토큰을 새로 발급해야 합니다.


### `POST /api/v1/team/members/:id/send-reset`

특정 멤버의 비밀번호 재설정 링크를 만들고 SMTP가 설정되어 있으면 이메일로도 보냅니다. **Admin 전용**.

**응답 `200`**

```json
{ "ok": true, "emailSent": true, "token": "abc123...", "resetUrl": "http://192.168.0.10:4000/reset-password?token=abc123..." }
```

링크는 2시간 동안 한 번만 쓸 수 있습니다. 새 링크를 만들면 그 멤버의 이전 링크는 더 이상 동작하지 않습니다. SMTP가 설정되지 않았거나 이메일 없이 초대된 멤버라면 `emailSent`는 `false`입니다. `resetUrl`은 [`POST /api/v1/team/invite`](#post-api-v1-team-invite)의 `inviteUrl`과 같은 규칙을 따릅니다. `null`이면 `<relay-url>/reset-password?token=<token>`으로 링크를 직접 만드세요.


## 앱 (Apps)

### `GET /api/v1/apps`

모든 앱 목록을 반환합니다. 각 앱에 최신 빌드 요약이 포함됩니다.

**응답 `200`**

```json
{
  "items": [
    {
      "id": 7,
      "name": "My App",
      "bundle_id_key": "com.example.app",
      "bundle_ids": { "ios": "com.example.app", "android": "com.example.android" },
      "build_platforms": ["android", "ios"],
      "platform": "both",
      "created_at": "2025-05-01T00:00:00.000Z",
      "latest_build_id": 42,
      "version_name": "1.2.3",
      "build_number": "89",
      "status_label": "In Progress",
      "latest_uploaded_at": "2025-05-15T12:00:00.000Z"
    }
  ]
}
```

`bundle_ids`는 플랫폼별 bundle ID입니다. 그 플랫폼에 ID가 없으면 `null`입니다. `bundle_id_key`는 예전 클라이언트를 위해 남겨 둔 값입니다. 두 ID가 다르면 iOS 쪽을 담습니다. `build_platforms`는 빌드가 있는 플랫폼입니다.


### `POST /api/v1/apps`

앱을 수동으로 생성합니다. **Admin, Developer, QA** 권한이 필요합니다. Viewer는 `403`을 받습니다. 같은 `bundle_id_key`인 앱이 이미 있으면 플랫폼과 관계없이 `409`를 받습니다. iOS와 Android에서 같은 bundle ID를 쓰는 앱은 `both`로 한 번만 만드세요. 플랫폼마다 bundle ID가 다르면 한쪽 플랫폼으로 만든 뒤, 다른 플랫폼 빌드를 `app_id`를 지정해 올리세요. 그 빌드의 bundle ID가 앱에 추가됩니다. `__unknown__`은 예약된 값이라 `400`을 받습니다.

```
Body (JSON):
  name          string            필수
  bundle_id_key string            필수
  platform      ios|android|both  필수
```

**응답 `201`**

```json
{ "id": 7, "ok": true }
```


### `PATCH /api/v1/apps/:id`

앱 이름을 수정합니다. **Admin, Developer, QA** 권한이 필요합니다. Viewer는 `403`을 받습니다.

```
Body (JSON):
  name  string  필수
```

**응답 `200`**

```json
{ "ok": true }
```


### `DELETE /api/v1/apps/:id`

앱과 하위의 모든 빌드, 그리고 빌드에 딸린 댓글·녹화·실행 기록과 파일을 삭제합니다. **Admin, Developer, QA** 권한이 필요합니다. Viewer는 `403`을 받습니다.

**응답 `200`**

```json
{ "ok": true }
```


### `POST /api/v1/apps/:id/merge`

다른 앱의 한 플랫폼을 이 앱으로 옮깁니다. 그 플랫폼의 bundle ID와 빌드가 함께 옮겨집니다. 빌드에 딸린 댓글·녹화·실행 기록도 따라옵니다. 옮긴 뒤 원래 앱에 남은 것이 없으면 원래 앱은 삭제됩니다. 앱 이름은 이 앱의 이름을 그대로 씁니다. 되돌리려면 [`POST /api/v1/apps/:id/split`](#post-api-v1-apps-id-split)로 그 플랫폼을 다시 떼어 냅니다. 삭제된 앱의 이름은 돌아오지 않습니다. **Admin, Developer, QA** 권한이 필요합니다.

```
Body (JSON):
  fromAppId  number        필수  옮겨 올 앱
  platform   ios|android   필수  옮길 플랫폼
```

**응답 `200`**

```json
{ "ok": true, "appId": 7, "removedAppId": 9 }
```

`removedAppId`는 원래 앱이 삭제됐을 때만 있습니다. 옮기는 플랫폼에 bundle ID가 있는데 이 앱에도 그 플랫폼의 bundle ID가 이미 있으면 `409`를 받습니다. 원래 앱이 두 플랫폼에 같은 ID를 쓰거나, 다른 플랫폼의 bundle ID를 가진 빌드가 있어 한 플랫폼만 떼어 낼 수 없을 때도 `409`를 받습니다. 앱이 없으면 `404`를 받습니다. 같은 앱끼리, 원래 앱에 그 플랫폼이 없을 때, 두 앱 중 하나가 bundle ID를 읽지 못한 빌드를 모아 둔 앱(`__unknown__`)일 때는 `400`을 받습니다.

### `POST /api/v1/apps/:id/split`

이 앱의 한 플랫폼을 새 앱으로 옮깁니다. 병합의 반대입니다. 그 플랫폼의 bundle ID와 빌드가 함께 옮겨집니다. 빌드에 딸린 댓글·녹화·실행 기록도 따라갑니다. 새 앱은 목록 맨 위에 나옵니다. **Admin, Developer, QA** 권한이 필요합니다.

```
Body (JSON):
  platform   ios|android   필수  옮길 플랫폼
  name       string        필수  새 앱 이름
```

**응답 `200`**

```json
{ "ok": true, "appId": 12 }
```

`appId`는 새 앱입니다. 이 앱에는 다른 플랫폼이 남아야 하므로 플랫폼이 하나뿐인 앱은 `400`을 받습니다. 이 앱이 두 플랫폼에 같은 bundle ID를 쓰거나 다른 플랫폼의 bundle ID를 가진 빌드가 있으면 `409`를 받습니다. 앱이 없으면 `404`를 받습니다. 이름이 비었을 때, 이 앱에 그 플랫폼이 없을 때, bundle ID를 읽지 못한 빌드를 모아 둔 앱(`__unknown__`)일 때는 `400`을 받습니다.

이 앱의 `app_id`로 올린 업로드라도 옮긴 bundle ID를 가졌으면 새 앱으로 갑니다. bundle ID를 읽지 못한 빌드는 `app_id`를 따라갑니다. 그래서 옮긴 플랫폼에 bundle ID가 없었다면 CI의 `app_id`를 새 앱으로 바꾸세요.


## 빌드 (Builds)

### `POST /api/v1/builds`

빌드를 업로드합니다. Viewer는 쿠키로 호출하든 자기 PAT로 호출하든 `403`을 받습니다.

```
Content-Type: multipart/form-data
Authorization: Bearer tflw_pat_<token>  (또는 세션 쿠키)
```

`file`만 필수이고 나머지는 모두 선택입니다.

| 필드 | 필수 | 설명 |
|------|------|------|
| `file` | 필수 | 빌드 산출물. iOS는 `.app.zip` 또는 `.tar.gz`/`.tgz`(시뮬레이터 빌드), Android는 `.apk`입니다. 최대 크기는 기본 500MB이며 `TAPFLOW_MAX_BUILD_BYTES`로 바꿀 수 있습니다. `.ipa`·`.aab`는 거부됩니다. |
| `status` | 선택 | 초기 리뷰 상태로 `Backlog`, `In Progress`, `Done`, `Rejected` 중 하나입니다. 생략하면 미설정으로 둡니다. |
| `label` | 선택 | App Center에서 빌드를 식별하는 자유 텍스트 레이블입니다(예: 브랜치명이나 `rc-1`). 응답에는 `version_label`로 나옵니다. 빌드 파일에 앱 이름이 없을 때 앱 이름으로 쓰지 않습니다(그때는 파일 이름). |
| `version_name` | 선택 | 빌드 파일의 버전 대신 쓸 값입니다. 빌드를 보여 주고 묶는 데 쓰이고 파일은 바뀌지 않습니다. 빈 값이면 파일의 값을 씁니다. |
| `build_number` | 선택 | 빌드 파일의 빌드 번호 대신 쓸 값입니다. 규칙은 `version_name`과 같습니다. |
| `platform` | 선택 | 무시됩니다. 플랫폼은 파일 형식으로 정해집니다. |
| `app_id` | 선택 | 기존 앱에 연결합니다. 그 앱에 해당 플랫폼의 bundle ID가 없고 다른 앱도 그 ID를 쓰지 않으면, 빌드의 bundle ID가 그 앱에 추가됩니다. 그렇지 않으면 빌드는 자기 bundle ID의 앱으로 갑니다. 병합으로 삭제된 앱의 `app_id`를 보내도 bundle ID로 앱을 찾아 연결합니다. 생략하면 bundle ID로 앱이 정해집니다. |

::: warning iOS 빌드 주의사항
`.ipa` 파일은 지원하지 않습니다. `.app.zip`을 올리거나, 클라우드 시뮬레이터 빌드가 만드는 `.tar.gz`/`.tgz`를 올리세요. `.app.zip`은 `xcodebuild -sdk iphonesimulator`로 빌드한 `.app` 폴더를 zip으로 압축하면 됩니다.
:::

`label`, `version_name`, `build_number`는 앞뒤 공백을 지우고 저장합니다. 100자를 넘는 `label`은 100자로 자릅니다. 100자를 넘는 `version_name`이나 `build_number`는 `400`을 받습니다.

**응답 `201`**

```json
{
  "id": 42,
  "app_id": 7,
  "name": "My App",
  "version_name": "1.2.3",
  "build_number": "89",
  "binary": { "version_name": "1.2.3", "build_number": "89" },
  "version_label": "rc-1",
  "bundle_id": "com.example.app",
  "status_label": "In Progress",
  "platform": "ios",
  "uploaded_at": "2025-05-15T12:00:00.000Z"
}
```

`version_name`과 `build_number`는 지금 쓰이는 값입니다. 덮어쓴 값이 있으면 그 값입니다. `binary`는 빌드 파일에서 읽은 값입니다. 두 값이 다르면 그 값을 사람이 바꾼 빌드입니다. 빌드 목록과 단건 조회 응답도 같습니다.


### `GET /api/v1/builds`

빌드 목록을 페이지네이션으로 반환합니다.

```
Query:
  page      number               페이지 번호 (기본값: 0)
  limit     number               페이지 크기 (기본값: 20, 최대: 100)
  q         string               버전명이나 레이블(version_label)로 검색
  platform  ios|android          플랫폼 필터
  status    Backlog|In Progress|Done|Rejected  상태 필터
  app_id    number               특정 앱의 빌드만 조회
  sort      uploaded_at|version_name|status_label  정렬 기준 (기본값: uploaded_at)
  dir       asc|desc             정렬 방향 (기본값: desc)
```

**응답 `200`**

```json
{
  "items": [ { ... } ],
  "total": 128
}
```


### `GET /api/v1/builds/:id`

빌드 단건을 조회합니다.

**응답 `200`**

```json
{
  "id": 42,
  "app_id": 7,
  "name": "My App",
  "version_name": "1.2.3",
  "build_number": "89",
  "binary": { "version_name": "1.2.3", "build_number": "89" },
  "version_label": "rc-1",
  "status_label": "In Progress",
  "platform": "ios",
  "bundle_id": "com.example.app",
  "uploaded_at": "2025-05-15T12:00:00.000Z",
  "completed_at": null,
  "delete_after": null
}
```

`delete_after`는 빌드 파일이 삭제되는 시각입니다. 삭제가 예약되지 않았으면 `null`입니다. `status_label`과 독립적이라 빌드를 `Done`으로 표시해도 삭제가 예약되지 않습니다.


### `PATCH /api/v1/builds/:id`

빌드의 상태, 레이블, 버전, 빌드 번호를 수정합니다. Viewer는 `403`을 받습니다.

```
Body (JSON):
  status_label  Backlog|In Progress|Done|Rejected|null  선택
  version_label string|null                              선택
  version_name  string|null                              선택  빈 값이나 null이면 빌드 파일의 값으로
  build_number  string|null                              선택  빈 값이나 null이면 빌드 파일의 값으로
```

텍스트 필드는 앞뒤 공백을 지우고 저장하며 최대 100자입니다. 넘거나 텍스트가 아니면 `400`을 받습니다. 빈 `version_label`은 레이블을 지웁니다. 빌드 파일과 같은 버전이나 빌드 번호를 보내면 덮어쓰지 않은 것으로 저장합니다.

**응답 `200`**

```json
{ "ok": true }
```


### `POST /api/v1/builds/:id/schedule-deletion`

빌드 삭제를 예약합니다. 서버가 `delete_after = now + TAPFLOW_BUILD_TTL_DAYS`로 설정하고 그 시각이 지나면 파일과 레코드를 삭제합니다. Viewer는 `403`을 받습니다.

**응답 `200`**

```json
{ "ok": true, "delete_after": "2025-05-22 12:00:00" }
```


### `DELETE /api/v1/builds/:id/schedule-deletion`

예약한 삭제를 취소하고 `delete_after`를 비웁니다. Viewer는 `403`을 받습니다.

**응답 `200`**

```json
{ "ok": true }
```


## 웹훅 (Webhooks)

빌드 리뷰 상태가 바뀔 때 알림을 받을 엔드포인트를 관리합니다. 모두 세션 쿠키나 `builds:write` scope의 PAT로 호출합니다. 웹훅 URL 자체가 비밀인 경우가 많아서 Viewer는 목록 조회를 포함한 모든 웹훅 엔드포인트에서 `403`을 받습니다. 페이로드와 서명 검증은 [웹훅](/ko/operate/webhooks)에서 다룹니다.

### `GET /api/v1/webhooks`

등록된 웹훅 목록을 반환합니다. secret 값은 반환하지 않고 설정 여부만 `has_secret`으로 알려 줍니다.

**응답 `200`**

```json
{
  "webhooks": [
    { "id": 1, "url": "https://ci.internal/hooks/tapflow", "enabled": true, "has_secret": true, "created_at": "2025-05-01 00:00:00" }
  ]
}
```


### `POST /api/v1/webhooks`

웹훅을 등록합니다.

```
Body (JSON):
  url      string        필수
  secret   string|null   선택 (HMAC 서명 secret)
  enabled  boolean       선택 (기본값: true)
```

**응답 `201`**: 등록된 웹훅 (`GET` 목록의 항목과 같은 형태)


### `PATCH /api/v1/webhooks/:id`

웹훅의 `url`, `secret`, `enabled` 중 보낸 필드만 수정합니다.

**응답 `200`**: 수정된 웹훅. 바꿀 필드가 없으면 `400`, 웹훅이 없으면 `404`입니다.


### `DELETE /api/v1/webhooks/:id`

웹훅을 삭제합니다.

**응답 `200`**

```json
{ "ok": true }
```


## 댓글 (Comments)

### `GET /api/v1/comments`

빌드별 댓글 목록을 반환합니다.

```
Query:
  build_id  number  필수
```

**응답 `200`**

```json
[
  {
    "id": 1,
    "body": "로그인 버튼이 안 눌려요",
    "created_at": "2025-05-15T12:00:00.000Z",
    "author": "Kim QA",
    "authorAvatarUrl": "/uploads/avatars/user-3.png",
    "attachments": [
      { "id": 3, "file_path": "/uploads/comments/...", "mime": "image/png" }
    ]
  }
]
```

`author`는 작성자의 표시 이름이고 표시 이름이 없으면 이메일의 `@` 앞부분입니다. `authorAvatarUrl`은 프로필 이미지가 없으면 `null`입니다.


### `POST /api/v1/comments`

댓글을 작성합니다. 이미지를 첨부할 수 있습니다. 세션 쿠키나 `builds:write` scope의 PAT로 호출합니다. Viewer를 포함한 모든 역할이 작성할 수 있습니다.

```
Content-Type: multipart/form-data

Fields:
  build_id  number  필수
  body      string  필수
File:
  attachment  이미지 (PNG/JPEG/WebP, 최대 5MB) — 선택
```

**응답 `201`**

```json
{
  "id": 1,
  "body": "로그인 버튼이 안 눌려요",
  "created_at": "2025-05-15T12:00:00.000Z",
  "author": "Kim QA"
}
```

이 응답의 `author`는 표시 이름 그대로이므로 표시 이름이 없으면 `null`입니다.


### `DELETE /api/v1/comments/:id`

댓글을 삭제합니다. 작성자 본인 또는 Admin만 가능합니다.

**응답 `204`** (본문 없음)


## 팀 (Team)

### `GET /api/v1/team/members`

전체 멤버 목록을 반환합니다. **Admin 전용**.

**응답 `200`**

```json
[
  {
    "id": 1,
    "email": "admin@example.com",
    "display_name": "Admin",
    "role": "Admin",
    "joined_at": "2025-05-01T00:00:00.000Z"
  }
]
```


### `POST /api/v1/team/invite`

팀원을 초대합니다. **Admin 전용**. 초대 링크는 **7일** 후 만료됩니다. `email`이 대소문자와 관계없이 이미 멤버의 이메일이면 `409`를 반환합니다.

```
Body (JSON):
  email  string                       선택 (생략하면 초대 메일을 보내지 않음)
  role   Admin|Developer|QA|Viewer    선택 (기본값: QA)
```

**응답 `201`**

```json
{ "token": "abc123...", "emailSent": true, "inviteUrl": "http://192.168.0.10:4000/invite?token=abc123..." }
```

SMTP가 설정되지 않았거나 `email`을 생략한 경우 `emailSent: false`가 반환됩니다. `inviteUrl`이 `null`이 아니면 초대 이메일의 링크와 같습니다. 터널의 `publicUrl`을 먼저 쓰고 없으면 `relay.url`(`TAPFLOW_RELAY_URL`)을 씁니다. `tapflow start`나 `tapflow relay start`가 터널을 띄우면 터널이 받은 주소를 씁니다(Tailscale이 감지한 주소 포함). 단독 실행한 릴레이는 설정값을 씁니다. 릴레이가 HTTPS로 동작하면 `http://` 터널 주소는 쓰지 않습니다. 후보가 없거나 `localhost`처럼 팀원이 열 수 없는 주소뿐이면 `null`입니다. 이때는 팀원이 접속하는 릴레이 주소로 `<relay-url>/invite?token=<token>` 링크를 직접 만드세요.


### `PATCH /api/v1/team/members/:id`

멤버의 역할을 변경합니다. **Admin 전용**.

```
Body (JSON):
  role  Admin|Developer|QA|Viewer  필수
```

**응답 `200`**

```json
{ "ok": true }
```


### `DELETE /api/v1/team/members/:id`

멤버를 삭제합니다. **Admin 전용**. 자기 자신은 삭제할 수 없습니다.

**응답 `204`** (본문 없음)


## 토큰 (Personal Access Tokens)

### `GET /api/v1/tokens`

PAT 목록을 반환합니다.

**응답 `200`**

```json
[
  {
    "id": 1,
    "name": "GitHub Actions",
    "scope": "builds:write",
    "last_used_at": "2025-05-15T12:00:00.000Z",
    "expires_at": null,
    "created_at": "2025-05-01T00:00:00.000Z"
  }
]
```


### `POST /api/v1/tokens`

PAT를 생성합니다. 토큰 값은 **생성 직후 한 번만** 반환됩니다.

```
Body (JSON):
  name            string  필수
  expires_in_days number  선택 (없거나 0이면 만료 없음)
  scope           string  선택 (콤마로 구분. 기본값: view,builds:write)
```

`expires_in_days`에는 0 이상의 일수를 보냅니다(`"30"` 같은 숫자 문자열도 됩니다). 음수, 빈 문자열을 포함해 숫자가 아닌 값, 날짜로 표현할 수 없을 만큼 큰 값을 보내면 `400`을 반환합니다. 대시보드에서는 1~365일만 입력할 수 있지만 API에는 상한이 없습니다.

`scope`에는 `view`, `builds:write`, `agent`를 쓸 수 있습니다. `agent` scope는 원격 Mac의 에이전트가 릴레이에 연결할 때 쓰며 Admin만 발급할 수 있습니다. 다른 역할이 요청하면 `403`을 반환합니다.

**응답 `201`**

```json
{ "token": "tflw_pat_abc123..." }
```


### `DELETE /api/v1/tokens/:id`

PAT를 즉시 무효화합니다.

**응답 `204`** (본문 없음)


## 프로필 (Profile)

### `PATCH /api/v1/profile`

현재 로그인한 사용자의 프로필을 수정합니다.

```
Content-Type: multipart/form-data

Fields:
  display_name  string  선택
File:
  avatar        이미지 (PNG/JPEG, 최대 2MB) — 선택
```

**응답 `200`**

```json
{ "ok": true }
```


## 설정 (Settings) {#settings}

<a id="설정-settings"></a>

### `GET /api/v1/settings`

팀 설정을 조회합니다. 로그인이 필요합니다.

**응답 `200`**

```json
{
  "team_name": "My Team",
  "logo_url": "/uploads/team/logo.png",
  "video_pass_retention_days": 3,
  "video_storage_cap_mb": 20480,
  "video_usage_bytes": 5368709120,
  "video_effective_cap_bytes": 21474836480
}
```

로고가 없으면 `logo_url`은 `null`입니다. `video_*`는 [플로우 영상](#run-videos) 보관 설정입니다. `video_usage_bytes`는 지금 영상이 쓰는 용량이고 `video_effective_cap_bytes`는 설정한 저장 공간과 디스크에 실제로 남은 공간 중 작은 쪽입니다.


### `PATCH /api/v1/settings`

팀 설정을 수정합니다. **Admin 전용**.

```
Content-Type: multipart/form-data

Fields:
  team_name                  string  선택
  video_pass_retention_days  number  선택  통과한 플로우의 영상을 남길 일수. 0–365
  video_storage_cap_mb       number  선택  영상에 쓸 저장 공간(MB). 100–10485760
File:
  logo       이미지 (PNG/JPEG, 최대 2MB) — 선택
```

**응답 `200`**

```json
{ "ok": true }
```


## 녹화 (Recordings)

### `POST /api/v1/recordings/upload`

녹화 파일을 업로드합니다. 업로드 후 **72시간** 뒤에 자동 삭제됩니다.

```
Content-Type: multipart/form-data
Query:
  sessionId  string  선택
  buildId    number  선택

File:
  (필드 이름 무관)  webm 등 영상 파일  필수
```

**응답 `200`**

```json
{ "url": "/api/v1/recordings/abc123.webm" }
```


### `GET /api/v1/recordings`

녹화 목록을 반환합니다.

```
Query:
  buildId  number  선택
```

**응답 `200`**

```json
[
  {
    "id": 1,
    "url": "/api/v1/recordings/abc123.webm",
    "sessionId": "sess_xxx",
    "fileSize": 1048576,
    "mime": "video/webm",
    "createdAt": "2025-05-15T12:00:00.000Z",
    "expiresAt": "2025-05-18T12:00:00.000Z"
  }
]
```


### `GET /api/v1/recordings/:filename`

녹화 파일을 다운로드합니다. 만료된 파일은 `404`를 반환합니다.


## 실행 기록 (Runs) {#runs}

`tapflow flow run`이 실행마다 남기는 기록입니다. CLI가 토큰으로 쓰고, 대시보드의 [Flow Runs](/ko/automation/runs) 페이지가 읽습니다. 직접 호출할 일은 드물지만 CI 대시보드를 따로 만든다면 읽기 엔드포인트를 쓸 수 있습니다.

쓰기 엔드포인트(`POST`)는 `builds:write` 스코프와 쓰기 가능한 역할이 필요하고 실행을 만든 사용자만 쓸 수 있습니다. PAT로 만든 실행은 같은 PAT로만 쓸 수 있습니다. 다른 사용자나 다른 토큰은 `403`, 이미 끝난 실행에 쓰면 `409`를 받습니다. JSON 본문은 1MB까지 받습니다.

빌드에 딸린 실행은 그 빌드가 지워질 때 함께 지워지고 빌드 없이 만든 실행은 7일 뒤 지워집니다.

### `POST /api/v1/runs`

실행 기록을 만듭니다.

```
Body (JSON):
  client   string  필수  러너의 WebSocket ?client= 값. 이 소켓이 열려 있는 동안 실행이 진행 중인 것으로 봅니다
  flows    array   필수  실행할 플로우 [{ name, file? }], 최대 500개
  buildId  number  선택  테스트하는 빌드
  ci       object  선택  { provider?, branch?, commit?, jobUrl? }. jobUrl은 http(s) 주소만 저장합니다
  serviceTier  object  선택  실행이 기기를 켤 때 요청한 서비스 범위 { name: "stock" | "lean" | "slim", keep: [기능] }. 기기를 켜기 전에 요청한 값 그대로 저장합니다. 형식이 맞지 않으면 저장하지 않습니다
  resetRequested  boolean  선택  실행이 기기 초기화를 요청했는지. 초기화 결과를 보고받지 못한 실행과 초기화를 요청하지 않은 실행을 구분하는 데 씁니다
```

**응답 `201`**

```json
{ "id": "3f2b0c7e-8a41-4b5e-9d0f-1c2d3e4f5a6b" }
```

### `POST /api/v1/runs/:id/device`

기기를 켠 결과를 보고합니다. 이미 켜져 있었는지와 무엇을 초기화했는지를 담습니다. 러너는 부팅 응답을 받는 즉시 보내므로 설치에 실패하거나 취소된 실행에도 남습니다.

```
Body (JSON):
  sessionId   string   선택  기기를 붙잡은 세션. 여러 기기에서 도는 실행은 세션마다 따로 저장합니다
  deviceId, deviceName  string  선택
  cold        boolean  선택  false면 이미 켜져 있던 기기입니다
  runReset    object   선택  { done: [항목], failed: [항목] }. 형식이 맞지 않으면 저장하지 않습니다
```

같은 세션으로 다시 보고하면 그 기기의 기록만 덮어씁니다.

**응답 `200`** `{ "ok": true }`

### `POST /api/v1/runs/:id/flows/:idx/start`

`idx`번째 플로우를 기기에서 시작했다고 알립니다. 대시보드는 이 보고를 받은 플로우를 그 기기에서 실행 중으로 표시합니다. 이미 결과를 보고한 플로우에는 영향이 없습니다.

```
Body (JSON):
  sessionId   string  필수  플로우를 실행하는 기기의 세션
  deviceId, deviceName  string  선택
```

**응답 `200`** `{ "ok": true }`. `sessionId`가 없으면 `400`을 받습니다.

### `POST /api/v1/runs/:id/flows/:idx`

`idx`번째 플로우의 결과를 보고합니다. 같은 플로우를 다시 보고하면 덮어씁니다.

```
Body (JSON):
  status          "passed" | "failed" | "skipped"  필수
  skipReason      string               skipped일 때 필수, 아니면 보내지 않음  "app-mismatch" | "tag-filter"
  durationMs      number               필수
  steps           array                필수  [{ index, name, status: "passed"|"failed"|"skipped", durationMs, message? }], 최대 1000개
  failureKind     string               선택  "product" | "environment"
  failureMessage  string               선택  skipped 플로우에서는 건너뛴 이유를 사람이 읽는 문장으로
  deviceId, deviceName, platform  string  선택
```

`skipped`는 러너가 실행하지 않은 플로우입니다. `app-mismatch`는 플로우의 `appId`가 빌드와 다른 경우, `tag-filter`는 태그 옵션에 걸러진 경우입니다. skipped 플로우에는 스크린샷을 올릴 수 없고 이미 `passed`나 `failed`로 보고한 플로우는 skipped로 다시 보고할 수 없습니다(`409`).

**응답 `200`** `{ "ok": true }`

### `POST /api/v1/runs/:id/flows/:idx/screenshot`

보고한 플로우의 스크린샷을 올립니다. 실패한 플로우는 실패한 화면, 통과한 플로우는 끝난 화면입니다. 본문은 이미지 바이트 그대로이고 릴레이는 앞부분 바이트로 PNG나 JPEG인지 판단합니다. 5MB를 넘으면 `413`, 이미지가 아니면 `415`를 받습니다.

**응답 `200`** `{ "ok": true }`

### `POST /api/v1/runs/:id/finish`

실행을 끝냅니다.

```
Body (JSON):
  status        "passed" | "failed" | "aborted"  필수
  exitCode      number                           필수
  failureKind   string                           선택
  errorMessage  string                           선택  플로우를 시작하기 전에 실패한 이유 등
```

**응답 `200`** `{ "ok": true }`

### `GET /api/v1/runs`

실행 기록 목록을 최신순으로 돌려줍니다. 세션 쿠키나 `view` 스코프 PAT로 호출합니다.

```
Query:
  ci      "1" | "0"  선택  CI 실행만 / 로컬 실행만
  status  string     선택  running | passed | failed | aborted
  flow    string     선택  플로우 이름의 일부(영문 대소문자 무시)
  build   number     선택
  before  string     선택  이전 응답의 nextCursor. 더 오래된 실행 페이지
  after   string     선택  이전 응답의 prevCursor. 더 최근 실행 페이지
  limit   number     선택  기본 50, 최대 100
```

`build`, `before`, `after`에 0 이상의 정수가 아닌 값을 주면 `400`을 받습니다. 빈 값은 주지 않은 것으로 봅니다.

**응답 `200`**

```json
{
  "items": [
    {
      "id": "3f2b0c7e-8a41-4b5e-9d0f-1c2d3e4f5a6b",
      "status": "failed",
      "finishedBy": "client",
      "failureKind": "product",
      "errorMessage": null,
      "exitCode": 1,
      "isCi": true,
      "ci": { "provider": "github", "branch": "main", "commit": "abc1234", "jobUrl": "https://github.com/acme/app/actions/runs/1" },
      "serviceTier": null,
      "build": { "id": 7, "appName": "Coffee", "versionName": "1.2.0", "buildNumber": "42", "platform": "ios" },
      "createdBy": "ci-bot",
      "flowsTotal": 2,
      "flowsPassed": 1,
      "flowsFailed": 1,
      "flowsSkipped": 0,
      "createdAt": "2026-10-11 01:00:00",
      "finishedAt": "2026-10-11 01:01:05"
    }
  ],
  "nextCursor": null,
  "prevCursor": null
}
```

`finishedBy`가 `relay`이면 러너가 끝을 알리기 전에 연결이 끊겨 릴레이가 닫은 실행입니다.

### `GET /api/v1/runs/:id`

실행 하나와 플로우별 결과를 돌려줍니다. 목록 항목의 필드에 아래가 더해집니다.

- `deviceReset`: 실행이 기기를 초기화했는지입니다. 초기화 기능보다 오래된 러너의 실행은 `null`입니다. `requested`는 요청 여부이고 기기를 켠 결과를 보고받으면 `booted`, `cold`, `report`가 더해집니다. 러너가 세션을 알려 주면 `devices`에 기기마다 `sessionId`, `deviceId`, `deviceName`, `cold`, `report`가 담깁니다. 기기가 여럿이면 바깥 필드는 첫 기기의 결과입니다. 이 필드는 목록 항목에도 있습니다.
- `flows`: 계획된 플로우 순서대로입니다. 보고된 플로우는 `status`(`passed`·`failed`)와 `steps`, `device`, `durationMs`, `hasScreenshot`을 담습니다. 건너뛴 플로우는 `status: "skipped"`와 `skipReason`, 이유를 담은 `failureMessage`를 담습니다. 영상이 있는 플로우는 `video`에 `ended`, `endReason`, `evicted`, `notRecorded`, `bytes`를 담고 영상이 없으면 `null`입니다. `notRecorded`는 러너가 영상을 남길 수 없었던 이유(`jpeg`, `no-keyframe`)입니다. 아직 보고되지 않은 플로우는 진행 중인 실행에서 `running`(지금 실행 중)이나 `pending`, 끝난 실행에서 `not-run`입니다. 러너가 시작을 알린 `running` 플로우에는 `device`(`id`, `name`, `sessionId`)가 있습니다. 시작을 알리지 않는 옛 러너의 실행에서는 보고되지 않은 첫 플로우를 `running`으로 표시합니다.
- `watchSessionId`: 러너가 지금 붙잡고 있는 세션 ID입니다. 진행 중일 때만 값이 있고 [AI 세션 보기](/ko/automation/mcp-server#watch-the-device) 페이지 주소에 씁니다.
- `watchSessionIds`: 러너가 지금 붙잡고 있는 세션 전부입니다. 여러 기기에서 도는 실행은 기기마다 하나씩이고 끝난 실행에서는 빈 배열입니다.

존재하지 않는 실행이면 `404`를 받습니다.

### `GET /api/v1/runs/:id/flows/:idx/screenshot`

플로우의 스크린샷을 `image/png`나 `image/jpeg`로 돌려줍니다. 없으면 `404`를 받습니다.


## 플로우 영상 (Flow run videos) {#run-videos}

러너가 실행하면서 올리는 플로우별 영상입니다. 러너가 영상을 열고(`open`) 번호를 붙인 조각을 보낸 뒤(`chunks`) 닫으며(`end`) 대시보드는 조각 목록(`index`)을 읽고 영상 파일을 받습니다. 파일은 바이트 범위 요청에도 답합니다. 쓰기는 위의 다른 실행 엔드포인트와 같은 규칙을 따르고 러너가 `finish`를 보낸 뒤에도 120초 동안은 마지막 플로우의 끝부분을 받습니다. 통과한 플로우의 영상은 보관 기간이 지나거나 저장 공간이 차면 오래된 것부터 지워집니다. 보관 기간과 저장 공간은 [팀 설정](#settings)에서 정합니다.

### `POST /api/v1/runs/:id/flows/:idx/video/open`

플로우의 영상을 엽니다. 본문은 영상 메타데이터 JSON이며 16KB까지 받습니다. `formatVersion`은 `1`이어야 하고 나머지는 러너가 정하며 릴레이는 그대로 저장합니다.

**응답 `201`** `{ "ok": true, "nextSeq": 0 }`. 이미 열려 있으면 `200`과 다음에 보낼 `nextSeq`를, 이미 끝난 영상이면 `409`를 돌려줍니다.

### `POST /api/v1/runs/:id/flows/:idx/video/chunks/:seq`

`seq`번째 조각을 보냅니다. `seq`는 0부터 10000까지입니다. 본문은 조각의 바이트 그대로이며 8MB까지 받습니다.

```
Headers:
  X-Start-Ms  필수  조각의 첫 기록이 영상 시계에서 몇 ms인지
  X-Keyframe  선택  "1"이면 이 조각이 디코딩을 시작할 수 있는 키프레임으로 시작함
```

**응답 `200`** `{ "ok": true, "nextSeq": n }`. 이미 받은 조각을 다시 보내면 `200`과 `"duplicate": true`를 돌려줍니다. 열지 않은 영상은 `404`, 이미 끝난 영상은 `409`, 보관하지 않게 된 영상은 `410`을 받습니다. 조각이 8MB를 넘으면 `413`(`reason: "chunk-too-large"`), 플로우 하나의 영상이 100MB를 넘으면 `413`(`reason: "size-limit"`)을 받고 영상이 끝납니다. 저장 공간이 가득 차면 `507`(`reason: "storage-full"`)을 받고 영상이 끝납니다.

### `POST /api/v1/runs/:id/flows/:idx/video/end`

영상을 닫습니다. 처음 받은 종료만 기록하고 다시 보내도 결과가 같습니다.

```
Body (JSON):
  lastSeq  number  필수  마지막으로 보낸 조각 번호. 하나도 보내지 않았으면 -1
  reason   string  필수  done | cancelled | size-limit | storage-full | runner-lost | truncated
```

**응답 `200`** `{ "ok": true }`

### `GET /api/v1/runs/:id/flows/:idx/video/index`

영상의 조각 목록입니다. 세션 쿠키나 `view` 스코프 PAT로 호출합니다.

```json
{
  "meta": { "formatVersion": 1, "codec": "h264", "platform": "ios", "clockBase": 1760230395000, "flowStartMs": 1500 },
  "bytes": 2483201,
  "ended": true,
  "endReason": "done",
  "evicted": false,
  "chunks": [{ "seq": 0, "offset": 0, "length": 412300, "startMs": 0, "keyframe": true }],
  "gaps": []
}
```

`gaps`는 받지 못한 조각 번호입니다. `end`가 오지 않았어도 실행이 끝나고 120초가 지났거나 러너의 연결이 끊겨 릴레이가 실행을 닫았으면 `ended`는 `true`이고 `endReason`은 각각 `truncated`, `runner-lost`입니다.

### `GET /api/v1/runs/:id/flows/:idx/video`

영상 파일을 `application/octet-stream`으로 돌려줍니다. `Range` 헤더로 일부를 받을 수 있고(`206`) 범위를 벗어나면 `416`을 받습니다. 녹화 중인 영상은 `Cache-Control: no-store`이고 끝난 영상은 `private`과 `ETag`가 붙습니다. 보관하지 않게 된 영상은 `410`을 받습니다.



## 에이전트 (Agents)

### `GET /api/v1/agents`

리소스 기록이 남아 있는 에이전트의 이름 목록을 반환합니다. 기록은 30일간 보관되므로 지금 연결되어 있지 않은 에이전트도 포함될 수 있습니다.

**응답 `200`**

```json
["mac-mini-office", "mac-mini-lab"]
```


### `GET /api/v1/agents/:name/resources`

특정 에이전트의 CPU·RAM 시계열 데이터를 반환합니다.

```
Query:
  range  1h|6h|24h|7d  선택 (기본값: 1h)
```

**응답 `200`**

```json
[
  { "cpu_percent": 44.2, "mem_percent": 61.0, "recorded_at": "2025-05-15T12:00:00Z" }
]
```

데이터는 1분마다 샘플링되며 30일간 보관됩니다.


## 기기 설정 (Device settings) {#device-settings}

QA 세션 기기 목록에 적용되는 설정입니다. 릴레이에 저장되고 Mac의 기기는 바뀌지 않습니다. 기기는 `agent`와 `deviceId`로 가리킵니다. `agent`는 기기 목록(`agents:listed`)의 `agentKey`이고, `deviceId`는 그 기기의 `id`(iOS는 UDID, Android는 `avd:<AVD 이름>`)입니다. [기기 목록 정리](/ko/testing/qa-session#organize-devices)를 참고하세요.

### `PUT /api/v1/device-prefs`

기기를 숨기거나 이름을 붙입니다. 팀원 모두의 목록에 적용됩니다. **Admin** 권한이 필요합니다. 다른 역할은 `403`을 받습니다.

```
Body (JSON):
  agent        string          필수
  deviceId     string          필수
  hidden       boolean         선택  빼면 지금 값을 유지
  displayName  string | null   선택  빼면 지금 값을 유지. 빈 문자열이나 null이면 원래 이름으로 (최대 100자)
```

**응답 `200`**

```json
{ "ok": true, "hidden": true, "displayName": "Release phone" }
```

숨김도 이름도 없는 상태가 되면 저장된 설정을 지웁니다. 기기 목록은 숨긴 기기도 빼지 않고 `hidden: true`로 알려 줍니다. 그래서 MCP 클라이언트와 자동 실행은 숨긴 기기를 계속 쓸 수 있습니다.

### `PUT /api/v1/device-favourites`

기기를 내 즐겨찾기에 넣습니다. 즐겨찾기는 사람마다 따로 저장됩니다. 세션 쿠키나 `view` scope의 PAT로 호출하며 역할은 상관없습니다. 이미 즐겨찾기인 기기에 다시 호출해도 `200`입니다.

```
Body (JSON):
  agent     string  필수
  deviceId  string  필수
```

**응답 `200`**

```json
{ "ok": true }
```

### `DELETE /api/v1/device-favourites`

기기를 내 즐겨찾기에서 뺍니다. Body와 응답은 `PUT`과 같습니다.


## 세션 (Sessions)

`sessionId`는 MCP 서버의 `list_devices` 결과에서 확인합니다. 두 엔드포인트 모두 세션 쿠키나 `view` scope의 PAT로 호출합니다.

### `GET /api/v1/sessions/:sessionId/screenshot`

세션 기기의 현재 화면을 이미지로 반환합니다.

```
Query:
  format  png|jpeg  선택 (기본값: png)
```

**응답 `200`**: `image/png` 또는 `image/jpeg` 본문

세션이 없으면 `404`, 기기가 꺼져 있으면 `409`, 에이전트가 오프라인이거나 캡처에 실패하면 `502`, 10초 안에 응답이 없으면 `504`를 반환합니다.


### `GET /api/v1/sessions/:sessionId/ui-tree`

세션 기기의 현재 화면에 있는 UI 요소 목록을 반환합니다.

**응답 `200`**

```json
{
  "elements": [
    {
      "role": "button",
      "label": "Sign in",
      "identifier": "login_button",
      "frame": { "x": 0.1, "y": 0.8, "width": 0.8, "height": 0.06 },
      "enabled": true
    }
  ]
}
```

`frame`은 화면 크기에 대한 0–1 비율입니다. 오류 상태 코드는 스크린샷과 같으며 시간 초과는 15초입니다.


## 릴레이 (Relay)

### `GET /api/v1/relay/host`

대시보드가 팀원에게 줄 주소를 만들 때 쓰는 릴레이 주소 정보를 반환합니다. 로그인이 필요합니다.

**응답 `200`**

```json
{
  "lanHost": "192.168.0.10",
  "port": 4000,
  "publicBaseUrl": "https://tap.example.com",
  "agentRelayUrl": "wss://tap.example.com"
}
```

값을 정할 수 없는 항목은 `null`입니다. 컨테이너 안에서 실행하면 `lanHost`는 항상 `null`입니다.


## 로그 (Logs)

### `GET /api/v1/logs`

릴레이 인메모리 로그 버퍼(최근 500줄)를 반환합니다. 릴레이 호스트에서 보낸 요청에만 응답합니다. 다른 기기나 터널, 신뢰 프록시를 거친 원격 클라이언트는 인증 여부와 관계없이 `403`을 받습니다. 원격에서 로그를 보려면 릴레이 호스트의 출력(터미널, `journalctl`, `docker compose logs`)을 확인하세요.

```
Query:
  lines  number  선택 (1~500 사이 정수, 기본값: 100). 숫자가 아니면 100, 범위를 벗어나면 가까운 끝값을 씁니다.
```

**응답 `403`**

```json
{ "error": "Logs are only available on the relay host. Run `tapflow logs` there." }
```

**응답 `200`**

```json
[
  "[2025-05-15T12:00:00.000Z] ..."
]
```

## 관련 문서 {#related}

- [CI에서 빌드 올리기](/ko/operate/ci-distribution): PAT로 빌드 업로드하기
- [팀·역할·토큰](/ko/operate/team-and-roles): 역할별로 쓸 수 있는 엔드포인트와 토큰 발급
- [CLI 레퍼런스](/ko/reference/cli): 릴레이와 에이전트를 실행하는 명령
