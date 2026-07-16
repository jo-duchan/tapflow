# REST API

모든 엔드포인트는 릴레이의 `http(s)://<relay-host>/api/v1/`에서 제공됩니다.

**인증 방식**
- 대시보드 사용자: 세션 쿠키 (`tapflow_token`, 로그인 시 자동 설정)
- CI/CD 스크립트: `Authorization: Bearer tflw_pat_<token>` 헤더


## 에러 응답

모든 에러는 `{ "error": "..." }` 형태의 JSON을 반환합니다.

| 상태 코드 | 의미 | 예시 |
|---------|------|------|
| `400` | 잘못된 요청 (필드 누락, 형식 오류 등) | `{ "error": "file required" }` |
| `401` | 인증 없음 또는 만료 | `{ "error": "Unauthorized" }` |
| `403` | 권한 없음 | `{ "error": "Forbidden" }` 또는 `{ "error": "Insufficient scope" }` |
| `404` | 리소스를 찾을 수 없음 | `{ "error": "Build not found" }` |
| `410` | 토큰 만료 | `{ "error": "Invitation expired or not found" }` |
| `500` | 서버 오류 | `{ "error": "Internal server error" }` |

삭제 성공은 `204`에 본문 없이 반환됩니다.


## 인증 (Auth)

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

계정이 이미 존재하면 `403 { "error": "Already initialized" }`를 반환합니다.


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
  "avatarUrl": "/api/v1/uploads/avatars/...",
  "role": "Admin"
}
```


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


## 초대 (Invitations)

### `GET /api/v1/invitations/verify`

초대 토큰의 유효 여부를 확인합니다.

```
Query:
  token  string  필수 (32자 hex)
```

**응답 `200`**

```json
{ "role": "QA" }
```

만료되었거나 존재하지 않으면 `410`을 반환합니다.


### `POST /api/v1/invitations/accept`

초대를 수락하고 계정을 생성합니다. 성공 시 로그인 쿠키가 설정됩니다.

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

만료되었으면 `410`을 반환합니다.


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


### `POST /api/v1/team/members/:id/send-reset`

특정 멤버에게 비밀번호 재설정 이메일을 발송합니다. **Admin 전용**.

**응답 `200`**

```json
{ "ok": true, "emailSent": true }
```

SMTP가 설정되지 않은 경우 `emailSent: false`가 반환되며, 재설정 링크는 Admin이 직접 공유해야 합니다.


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
      "platform": "ios",
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


### `POST /api/v1/apps`

앱을 수동으로 생성합니다. **Admin 또는 Developer** 권한이 필요합니다.

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

앱 이름을 수정합니다. **Admin 또는 Developer** 권한이 필요합니다.

```
Body (JSON):
  name  string  필수
```

**응답 `200`**

```json
{ "ok": true }
```


### `DELETE /api/v1/apps/:id`

앱과 하위의 모든 빌드·댓글을 삭제합니다. **Admin 또는 Developer** 권한이 필요합니다.

**응답 `200`**

```json
{ "ok": true }
```


## 빌드 (Builds)

### `POST /api/v1/builds`

빌드를 업로드합니다.

```
Content-Type: multipart/form-data
Authorization: Bearer tflw_pat_<token>  (또는 세션 쿠키)
```

`file`만 필수이고 나머지는 모두 선택입니다.

| 필드 | 필수 | 설명 |
|------|------|------|
| `file` | 필수 | 빌드 산출물. iOS는 `.app.zip` 또는 `.tar.gz`/`.tgz`(시뮬레이터 빌드), Android는 `.apk`입니다. 최대 500MB이고 `.ipa`·`.aab`는 거부됩니다. |
| `status` | 선택 | 초기 리뷰 상태로 `Backlog`, `In Progress`, `Done`, `Rejected` 중 하나입니다. 생략하면 미설정으로 둡니다. |
| `label` | 선택 | App Center에서 빌드를 식별하는 자유 텍스트 레이블입니다(예: 브랜치명이나 `rc-1`). |
| `platform` | 선택 | `ios` 또는 `android`입니다. 생략하면 파일 형식에서 자동으로 정해집니다. |
| `app_id` | 선택 | 기존 앱에 명시적으로 연결합니다. 보통은 bundle ID로 앱이 자동 결정됩니다. |

::: warning iOS 빌드 주의사항
`.ipa` 파일은 지원하지 않습니다. `.app.zip`을 올리거나, 클라우드 시뮬레이터 빌드가 만드는 `.tar.gz`/`.tgz`를 올리세요. `.app.zip`은 `xcodebuild -sdk iphonesimulator`로 빌드한 `.app` 폴더를 zip으로 압축하면 됩니다.
:::

**응답 `201`**

```json
{
  "id": 42,
  "app_id": 7,
  "version_name": "1.2.3",
  "build_number": "89",
  "bundle_id": "com.example.app",
  "status_label": "In Progress",
  "platform": "ios",
  "uploaded_at": "2025-05-15T12:00:00.000Z"
}
```


### `GET /api/v1/builds`

빌드 목록을 페이지네이션으로 반환합니다.

```
Query:
  page      number               페이지 번호 (기본값: 0)
  limit     number               페이지 크기 (기본값: 20)
  q         string               버전명으로 검색
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
  "version_label": "rc-1",
  "status_label": "In Progress",
  "platform": "ios",
  "bundle_id": "com.example.app",
  "uploaded_at": "2025-05-15T12:00:00.000Z",
  "delete_after": null
}
```

`delete_after`는 빌드 파일이 삭제되는 시각입니다. 삭제가 예약되지 않았으면 `null`입니다. `status_label`과 독립적이라 빌드를 `Done`으로 표시해도 삭제가 예약되지 않습니다.


### `PATCH /api/v1/builds/:id`

빌드의 상태 또는 레이블을 수정합니다.

```
Body (JSON):
  status_label  Backlog|In Progress|Done|Rejected|null  선택
  version_label string|null                              선택
```

**응답 `200`**

```json
{ "ok": true }
```


### `POST /api/v1/builds/:id/schedule-deletion`

빌드 삭제를 예약합니다. 서버가 `delete_after = now + TAPFLOW_BUILD_TTL_DAYS`로 설정하고 그 시각이 지나면 파일과 레코드를 삭제합니다.

**응답 `200`**

```json
{ "ok": true }
```


### `DELETE /api/v1/builds/:id/schedule-deletion`

예약한 삭제를 취소하고 `delete_after`를 비웁니다.

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
    "author": "qa@example.com",
    "authorAvatarUrl": "...",
    "attachments": [
      { "id": 3, "file_path": "/uploads/comments/...", "mime": "image/png" }
    ]
  }
]
```


### `POST /api/v1/comments`

댓글을 작성합니다. 이미지를 첨부할 수 있습니다.

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
  "author": "qa@example.com"
}
```


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

팀원을 초대합니다. **Admin 전용**. 초대 링크는 **7일** 후 만료됩니다.

```
Body (JSON):
  email  string                       필수
  role   Admin|Developer|QA|Viewer    선택 (기본값: QA)
```

**응답 `201`**

```json
{ "token": "abc123...", "emailSent": true }
```

SMTP가 설정되지 않은 경우 `emailSent: false`가 반환됩니다. `token` 값을 사용해 `<relay-url>/invite?token=<token>` 링크를 직접 공유하세요.


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
  expires_in_days number  선택 (없으면 만료 없음)
```

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


## 설정 (Settings)

### `GET /api/v1/settings`

팀 설정을 조회합니다.

**응답 `200`**

```json
{ "team_name": "My Team", "logo_url": "..." }
```


### `PATCH /api/v1/settings`

팀 설정을 수정합니다. **Admin 전용**.

```
Content-Type: multipart/form-data

Fields:
  team_name  string  선택
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
  video  webm 등 영상 파일  필수
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


## 에이전트 (Agents)

### `GET /api/v1/agents`

연결된 에이전트 이름 목록을 반환합니다.

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


## 로그 (Logs)

### `GET /api/v1/logs`

릴레이 인메모리 로그 버퍼를 반환합니다.

```
Query:
  lines  number  선택 (기본값: 100, 최대: 500)
```

**응답 `200`**

```json
[
  "[2025-05-15T12:00:00.000Z] Agent mac-mini-office connected",
  "..."
]
```
