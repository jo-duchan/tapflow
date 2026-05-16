# REST API

All endpoints are served by the relay at `http(s)://<relay-host>/api/v1/`.

**Authentication**
- Dashboard users: session cookie (`tapflow_token`, set automatically on login)
- CI/CD scripts: `Authorization: Bearer tflw_pat_<token>` header

---

## Error responses

All errors return JSON in the form `{ "error": "..." }`.

| Status | Meaning | Example |
|--------|---------|---------|
| `400` | Bad request (missing field, invalid format, etc.) | `{ "error": "file required" }` |
| `401` | Not authenticated or session expired | `{ "error": "Unauthorized" }` |
| `403` | Forbidden | `{ "error": "Forbidden" }` or `{ "error": "Insufficient scope" }` |
| `404` | Resource not found | `{ "error": "Build not found" }` |
| `410` | Token expired | `{ "error": "Invitation expired or not found" }` |
| `500` | Server error | `{ "error": "Internal server error" }` |

Successful deletes return `204` with no body.

---

## Auth

### `POST /api/v1/auth/init`

Create the first admin account. Only works when no accounts exist yet.

```
Body (JSON):
  email     string  required
  password  string  required (min 8 chars)
```

**Response `201`**

```json
{ "ok": true }
```

Returns `403 { "error": "Already initialized" }` if an account already exists.

---

### `POST /api/v1/auth/login`

Sign in. Sets the `tapflow_token` cookie on success (valid for 7 days).

```
Body (JSON):
  email     string  required
  password  string  required
```

**Response `200`**

```json
{ "ok": true, "role": "Admin" }
```

---

### `POST /api/v1/auth/logout`

Sign out. Clears the session cookie.

**Response `200`**

```json
{ "ok": true }
```

---

### `GET /api/v1/auth/me`

Return the currently signed-in user's info.

**Response `200`**

```json
{
  "id": 1,
  "email": "admin@example.com",
  "displayName": "Admin",
  "avatarUrl": "/api/v1/uploads/avatars/...",
  "role": "Admin"
}
```

---

### `POST /api/v1/auth/change-password`

Change the current user's password.

```
Body (JSON):
  currentPassword  string  required
  newPassword      string  required (min 8 chars)
```

**Response `200`**

```json
{ "ok": true }
```

---

## Invitations

### `GET /api/v1/invitations/verify`

Check whether an invitation token is valid.

```
Query:
  token  string  required (32-char hex)
```

**Response `200`**

```json
{ "role": "QA" }
```

Returns `410` if expired or not found.

---

### `POST /api/v1/invitations/accept`

Accept an invitation and create an account. Sets a login cookie on success.

```
Content-Type: multipart/form-data

Fields:
  token         string  required
  password      string  required (min 8 chars)
  display_name  string  optional
File:
  avatar        image (PNG/JPEG, max 2 MB) — optional
```

**Response `200`**

```json
{ "ok": true }
```

---

## Password reset

### `GET /api/v1/auth/reset-password/verify`

Check whether a password reset token is valid.

```
Query:
  token  string  required
```

**Response `200`**

```json
{ "ok": true }
```

Returns `410` if expired.

---

### `POST /api/v1/auth/reset-password`

Reset the password.

```
Body (JSON):
  token     string  required
  password  string  required (min 8 chars)
```

**Response `200`**

```json
{ "ok": true }
```

---

### `POST /api/v1/team/members/:id/send-reset`

Send a password reset email to a specific member. **Admin only**.

**Response `200`**

```json
{ "ok": true, "emailSent": true }
```

If SMTP is not configured, `emailSent: false` is returned and the Admin must share the reset link manually.

---

## Apps

### `GET /api/v1/apps`

Return all apps. Each app includes a summary of its latest build.

**Response `200`**

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

---

### `POST /api/v1/apps`

Create an app manually. Requires **Admin or Developer** role.

```
Body (JSON):
  name          string            required
  bundle_id_key string            required
  platform      ios|android|both  required
```

**Response `201`**

```json
{ "id": 7, "ok": true }
```

---

### `PATCH /api/v1/apps/:id`

Rename an app. Requires **Admin or Developer** role.

```
Body (JSON):
  name  string  required
```

**Response `200`**

```json
{ "ok": true }
```

---

### `DELETE /api/v1/apps/:id`

Delete an app and all its builds and comments. Requires **Admin or Developer** role.

**Response `200`**

```json
{ "ok": true }
```

---

## Builds

### `POST /api/v1/builds`

Upload a build.

```
Content-Type: multipart/form-data
Authorization: Bearer tflw_pat_<token>  (or session cookie)

Fields:
  file    .app.zip (iOS) or .apk (Android) — max 500 MB  required
  status  Backlog | In Progress | Done | Rejected          optional
  label   custom label (e.g. "rc-1", "hotfix")             optional
  app_id  link to an existing App explicitly               optional
```

::: warning iOS builds
`.ipa` files are not supported. Use `.app.zip` only.
Build with `xcodebuild -sdk iphonesimulator`, then zip the `.app` folder.
:::

**Response `201`**

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

---

### `GET /api/v1/builds`

Return a paginated list of builds.

```
Query:
  page      number                                   page number (default: 0)
  limit     number                                   page size (default: 20)
  q         string                                   search by version name
  platform  ios|android                              platform filter
  status    Backlog|In Progress|Done|Rejected        status filter
  app_id    number                                   filter by app
  sort      uploaded_at|version_name|status_label    sort field (default: uploaded_at)
  dir       asc|desc                                 sort direction (default: desc)
```

**Response `200`**

```json
{
  "items": [ { ... } ],
  "total": 128
}
```

---

### `GET /api/v1/builds/:id`

Return a single build.

**Response `200`**

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
  "uploaded_at": "2025-05-15T12:00:00.000Z"
}
```

---

### `PATCH /api/v1/builds/:id`

Update the status or label of a build.

```
Body (JSON):
  status_label  Backlog|In Progress|Done|Rejected|null  optional
  version_label string|null                              optional
```

**Response `200`**

```json
{ "ok": true }
```

---

## Comments

### `GET /api/v1/comments`

Return comments for a build.

```
Query:
  build_id  number  required
```

**Response `200`**

```json
[
  {
    "id": 1,
    "body": "Login button is not tappable",
    "created_at": "2025-05-15T12:00:00.000Z",
    "author": "qa@example.com",
    "authorAvatarUrl": "...",
    "attachments": [
      { "id": 3, "file_path": "/uploads/comments/...", "mime": "image/png" }
    ]
  }
]
```

---

### `POST /api/v1/comments`

Post a comment. Supports image attachments.

```
Content-Type: multipart/form-data

Fields:
  build_id  number  required
  body      string  required
File:
  attachment  image (PNG/JPEG/WebP, max 5 MB) — optional
```

**Response `201`**

```json
{
  "id": 1,
  "body": "Login button is not tappable",
  "created_at": "2025-05-15T12:00:00.000Z",
  "author": "qa@example.com"
}
```

---

### `DELETE /api/v1/comments/:id`

Delete a comment. Only the author or an Admin can delete.

**Response `204`** (no body)

---

## Team

### `GET /api/v1/team/members`

Return all members. **Admin only**.

**Response `200`**

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

---

### `POST /api/v1/team/invite`

Invite a team member. **Admin only**. Invitations expire after **7 days**.

```
Body (JSON):
  email  string                       required
  role   Admin|Developer|QA|Viewer    optional (default: QA)
```

**Response `201`**

```json
{ "token": "abc123...", "emailSent": true }
```

If SMTP is not configured, `emailSent: false` is returned. Use the `token` to build the invite link: `<relay-url>/invite?token=<token>`.

---

### `PATCH /api/v1/team/members/:id`

Change a member's role. **Admin only**.

```
Body (JSON):
  role  Admin|Developer|QA|Viewer  required
```

**Response `200`**

```json
{ "ok": true }
```

---

### `DELETE /api/v1/team/members/:id`

Delete a member. **Admin only**. You cannot delete yourself.

**Response `204`** (no body)

---

## Tokens (Personal Access Tokens)

### `GET /api/v1/tokens`

Return the current user's PAT list.

**Response `200`**

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

---

### `POST /api/v1/tokens`

Create a PAT. The token value is returned **only once** at creation time.

```
Body (JSON):
  name            string  required
  expires_in_days number  optional (omit for no expiry)
```

**Response `201`**

```json
{ "token": "tflw_pat_abc123..." }
```

---

### `DELETE /api/v1/tokens/:id`

Immediately revoke a PAT.

**Response `204`** (no body)

---

## Profile

### `PATCH /api/v1/profile`

Update the current user's profile.

```
Content-Type: multipart/form-data

Fields:
  display_name  string  optional
File:
  avatar        image (PNG/JPEG, max 2 MB) — optional
```

**Response `200`**

```json
{ "ok": true }
```

---

## Settings

### `GET /api/v1/settings`

Return team settings.

**Response `200`**

```json
{ "team_name": "My Team", "logo_url": "..." }
```

---

### `PATCH /api/v1/settings`

Update team settings. **Admin only**.

```
Content-Type: multipart/form-data

Fields:
  team_name  string  optional
File:
  logo       image (PNG/JPEG, max 2 MB) — optional
```

**Response `200`**

```json
{ "ok": true }
```

---

## Recordings

### `POST /api/v1/recordings/upload`

Upload a recording file. Automatically deleted **72 hours** after upload.

```
Content-Type: multipart/form-data
Query:
  sessionId  string  optional
  buildId    number  optional

File:
  video  video file (webm, etc.)  required
```

**Response `200`**

```json
{ "url": "/api/v1/recordings/abc123.webm" }
```

---

### `GET /api/v1/recordings`

Return a list of recordings.

```
Query:
  buildId  number  optional
```

**Response `200`**

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

---

### `GET /api/v1/recordings/:filename`

Download a recording file. Returns `404` for expired files.

---

## Agents

### `GET /api/v1/agents`

Return the list of connected agent names.

**Response `200`**

```json
["mac-mini-office", "mac-mini-lab"]
```

---

### `GET /api/v1/agents/:name/resources`

Return CPU and RAM time-series data for a specific agent.

```
Query:
  range  1h|6h|24h|7d  optional (default: 1h)
```

**Response `200`**

```json
[
  { "cpu_percent": 44.2, "mem_percent": 61.0, "recorded_at": "2025-05-15T12:00:00Z" }
]
```

Data is sampled once per minute and retained for 30 days.

---

## Logs

### `GET /api/v1/logs`

Return the relay's in-memory log buffer.

```
Query:
  lines  number  optional (default: 100, max: 500)
```

**Response `200`**

```json
[
  "[2025-05-15T12:00:00.000Z] Agent mac-mini-office connected",
  "..."
]
```
