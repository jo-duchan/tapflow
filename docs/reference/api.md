# REST API

All endpoints are served by the relay at `http(s)://<relay-host>/api/v1/`.

**Authentication**
- Dashboard users: session cookie (`tapflow_token`, set automatically on login)
- CI/CD scripts: `Authorization: Bearer tflw_pat_<token>` header

Only the endpoints below accept a personal access token (PAT), and they accept the session cookie too.

| PAT scope | Endpoints |
|-----------|-----------|
| `builds:write` | `POST /builds`, `GET /builds`, `GET /builds/:id`, `POST /comments`, every webhook endpoint |
| `view` | `GET /apps`, `GET /sessions/:sessionId/screenshot`, `GET /sessions/:sessionId/ui-tree`, files under `/uploads/` (at the relay root, not under `/api/v1/`), device-session WebSockets opened from a remote machine |
| `agent` | A remote agent's WebSocket connection, accepted only while the member who issued the token is an Admin |

**Roles.** A call made with a PAT is held to its owner's current role. Viewer is read-only: uploading, updating or scheduling deletion of a build, creating, renaming or deleting an app, and every webhook endpoint return `403` for a Viewer. Reading builds and posting comments work for a Viewer too. The endpoints that check roles read the role on every request, so a role change applies there without signing in again or issuing a new token.


## Error responses

All errors return JSON in the form `{ "error": "..." }`.

| Status | Meaning | Example |
|--------|---------|---------|
| `400` | Bad request (missing field, invalid format, etc.) | `{ "error": "file required" }` |
| `401` | Not authenticated or session expired | `{ "error": "Unauthorized" }` |
| `403` | Forbidden | `{ "error": "Forbidden" }`, `{ "error": "Insufficient scope" }` or `{ "error": "Viewers have read-only access" }` |
| `404` | Resource not found | `{ "error": "Build not found" }` |
| `409` | Not possible in the current state | `{ "error": "Device is not booted" }` |
| `410` | Token expired | `{ "error": "Invitation expired or not found" }` |
| `429` | Too many requests (with a `Retry-After` header) | `{ "error": "Too many attempts. Try again later." }` |
| `500` | Server error | `{ "error": "Internal server error" }` |
| `502` | The agent is unreachable or returned an error | `{ "error": "Agent offline" }` |
| `504` | The agent did not answer in time | `{ "error": "Screenshot timed out" }` |

Deleting a comment, a member or a token returns `204` with no body. Deleting an app or a webhook, and cancelling a scheduled build deletion, return `200 { "ok": true }`.


## Auth

### `GET /api/v1/auth/status`

Whether the relay has an admin account yet. No authentication.

**Response `200`**

```json
{ "initialized": false, "canInitialize": true }
```

`canInitialize` is `true` when no account exists and this request comes from the relay host, the only place the first account can be created from. The setup page uses it to show the `tapflow admin init` instruction instead of the form.

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

Returns `403 { "error": "Already initialized" }` if an account already exists, and `403` with an error naming `tapflow admin init` if the request does not come from the relay host.


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

Repeated failed sign-ins from the same address for the same email return `429` with a `Retry-After` header.


### `POST /api/v1/auth/logout`

Sign out. Clears the session cookie.

**Response `200`**

```json
{ "ok": true }
```


### `GET /api/v1/auth/me`

Return the currently signed-in user's info.

**Response `200`**

```json
{
  "id": 1,
  "email": "admin@example.com",
  "displayName": "Admin",
  "avatarUrl": "/uploads/avatars/user-1.png",
  "role": "Admin"
}
```

`avatarUrl` is `null` when there is no profile image.


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


## Invitations

### `GET /api/v1/invitations/verify`

Check whether an invitation token is valid.

```
Query:
  token  string  required (64-char hex)
```

**Response `200`**

```json
{ "role": "QA" }
```

Returns `410` if expired or not found.


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

A reset token is valid for 2 hours after it is issued. Returns `410` if expired.


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


### `POST /api/v1/team/members/:id/send-reset`

Send a password reset email to a specific member. **Admin only**.

**Response `200`**

```json
{ "ok": true, "emailSent": true }
```

If SMTP is not configured, `emailSent: false` is returned and the Admin must share the reset link manually.


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


### `POST /api/v1/apps`

Create an app manually. Requires the **Admin, Developer or QA** role. A Viewer gets `403`.

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


### `PATCH /api/v1/apps/:id`

Rename an app. Requires the **Admin, Developer or QA** role. A Viewer gets `403`.

```
Body (JSON):
  name  string  required
```

**Response `200`**

```json
{ "ok": true }
```


### `DELETE /api/v1/apps/:id`

Delete an app and all its builds and comments. Requires the **Admin, Developer or QA** role. A Viewer gets `403`.

**Response `200`**

```json
{ "ok": true }
```


## Builds

### `POST /api/v1/builds`

Upload a build. A Viewer gets `403`, whether it calls with the cookie or with its own PAT.

```
Content-Type: multipart/form-data
Authorization: Bearer tflw_pat_<token>  (or session cookie)
```

Only `file` is required; every other field is optional.

| Field | Required | Description |
|-------|----------|-------------|
| `file` | Yes | The build artifact. iOS: `.app.zip` or `.tar.gz` / `.tgz` (a simulator build); Android: `.apk`. Max 500 MB by default (`TAPFLOW_MAX_BUILD_BYTES` changes it). `.ipa` and `.aab` are rejected. |
| `status` | No | Initial review status — one of `Backlog`, `In Progress`, `Done`, `Rejected`. Omit to leave it unset. |
| `label` | No | Free-text label to identify the build in App Center (e.g. a branch name or `rc-1`). |
| `platform` | No | `ios` or `android`. Derived from the file type when omitted. |
| `app_id` | No | Attach to an existing app explicitly. Normally the app is resolved automatically from the bundle ID. |

::: warning iOS builds
`.ipa` files are not supported. Upload `.app.zip`, or the `.tar.gz` / `.tgz` a cloud simulator build produces. Build `.app.zip` with `xcodebuild -sdk iphonesimulator` and zip the `.app` folder.
:::

**Response `201`**

```json
{
  "id": 42,
  "app_id": 7,
  "name": "My App",
  "version_name": "1.2.3",
  "build_number": "89",
  "bundle_id": "com.example.app",
  "status_label": "In Progress",
  "platform": "ios",
  "uploaded_at": "2025-05-15T12:00:00.000Z"
}
```


### `GET /api/v1/builds`

Return a paginated list of builds.

```
Query:
  page      number                                   page number (default: 0)
  limit     number                                   page size (default: 20, max: 100)
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
  "uploaded_at": "2025-05-15T12:00:00.000Z",
  "completed_at": null,
  "delete_after": null
}
```

`delete_after` is the time the build's files are purged, or `null` when no deletion is scheduled. It is independent of `status_label` — marking a build `Done` does not schedule deletion.


### `PATCH /api/v1/builds/:id`

Update the status or label of a build. A Viewer gets `403`.

```
Body (JSON):
  status_label  Backlog|In Progress|Done|Rejected|null  optional
  version_label string|null                              optional
```

**Response `200`**

```json
{ "ok": true }
```


### `POST /api/v1/builds/:id/schedule-deletion`

Schedule the build for deletion. The server sets `delete_after = now + TAPFLOW_BUILD_TTL_DAYS`; the files and record are purged after that time. A Viewer gets `403`.

**Response `200`**

```json
{ "ok": true, "delete_after": "2025-05-22 12:00:00" }
```


### `DELETE /api/v1/builds/:id/schedule-deletion`

Cancel a scheduled deletion, clearing `delete_after`. A Viewer gets `403`.

**Response `200`**

```json
{ "ok": true }
```


## Webhooks

Manage the endpoints notified when a build's review status changes. Every call takes the session cookie or a PAT with the `builds:write` scope. A webhook URL is often a secret in itself, so a Viewer gets `403` from every webhook endpoint, listing included. Payloads and signature verification are covered in [Webhooks](/guide/build-status-webhooks).

### `GET /api/v1/webhooks`

Return the registered webhooks. The secret itself is never returned; `has_secret` says whether one is set.

**Response `200`**

```json
{
  "webhooks": [
    { "id": 1, "url": "https://ci.internal/hooks/tapflow", "enabled": true, "has_secret": true, "created_at": "2025-05-01 00:00:00" }
  ]
}
```


### `POST /api/v1/webhooks`

Register a webhook.

```
Body (JSON):
  url      string        required
  secret   string|null   optional (HMAC signing secret)
  enabled  boolean       optional (default: true)
```

**Response `201`**: the registered webhook, in the same shape as an item in the `GET` list


### `PATCH /api/v1/webhooks/:id`

Update whichever of `url`, `secret` and `enabled` the body carries.

**Response `200`**: the updated webhook. `400` when there is nothing to update, `404` when the webhook does not exist.


### `DELETE /api/v1/webhooks/:id`

Delete a webhook.

**Response `200`**

```json
{ "ok": true }
```


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
    "author": "Kim QA",
    "authorAvatarUrl": "/uploads/avatars/user-3.png",
    "attachments": [
      { "id": 3, "file_path": "/uploads/comments/...", "mime": "image/png" }
    ]
  }
]
```

`author` is the author's display name, or the part of their email before `@` when they have none. `authorAvatarUrl` is `null` when there is no profile image.


### `POST /api/v1/comments`

Post a comment. Supports image attachments. Call it with the session cookie or a PAT with the `builds:write` scope. Every role can post, Viewer included.

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
  "author": "Kim QA"
}
```

`author` here is the display name as stored, so it is `null` when the author has none.


### `DELETE /api/v1/comments/:id`

Delete a comment. Only the author or an Admin can delete.

**Response `204`** (no body)


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


### `POST /api/v1/team/invite`

Invite a team member. **Admin only**. Invitations expire after **7 days**.

```
Body (JSON):
  email  string                       optional (omit to send no invitation email)
  role   Admin|Developer|QA|Viewer    optional (default: QA)
```

**Response `201`**

```json
{ "token": "abc123...", "emailSent": true, "inviteUrl": "http://192.168.0.10:4000/invite?token=abc123..." }
```

If SMTP is not configured or `email` is omitted, `emailSent: false` is returned. When `inviteUrl` is not `null`, it is the link the invitation email carries. It is built from the tunnel's `publicUrl`, otherwise `relay.url` (`TAPFLOW_RELAY_URL`). When `tapflow start` or `tapflow relay start` runs the tunnel, that is the address the tunnel got, including one Tailscale detected. A standalone relay uses the configured value. An `http://` tunnel address is not used when the relay serves HTTPS. `inviteUrl` is `null` when there is no candidate, or when the only one is an address a teammate cannot open, such as `localhost`. In that case, build the link from the address teammates use to reach the relay: `<relay-url>/invite?token=<token>`.


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


### `DELETE /api/v1/team/members/:id`

Delete a member. **Admin only**. You cannot delete yourself.

**Response `204`** (no body)


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


### `POST /api/v1/tokens`

Create a PAT. The token value is returned **only once** at creation time.

```
Body (JSON):
  name            string  required
  expires_in_days number  optional (omit or send 0 for no expiry)
  scope           string  optional (comma-separated; default: view,builds:write)
```

`expires_in_days` takes a number of days, 0 or more (a numeric string such as `"30"` works too). A negative value, anything that is not a number (including an empty string), or a count too large to be a date returns `400`. The dashboard accepts 1–365 days, but the API has no upper limit.

`scope` accepts `view`, `builds:write` and `agent`. The `agent` scope is what an agent on a remote Mac uses to connect to the relay, and only an Admin can issue it; any other role gets `403`.

**Response `201`**

```json
{ "token": "tflw_pat_abc123..." }
```


### `DELETE /api/v1/tokens/:id`

Immediately revoke a PAT.

**Response `204`** (no body)


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


## Settings

### `GET /api/v1/settings`

Return team settings. Requires sign-in.

**Response `200`**

```json
{ "team_name": "My Team", "logo_url": "/uploads/team/logo.png" }
```

`logo_url` is `null` when there is no logo.


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


## Recordings

### `POST /api/v1/recordings/upload`

Upload a recording file. Automatically deleted **72 hours** after upload.

```
Content-Type: multipart/form-data
Query:
  sessionId  string  optional
  buildId    number  optional

File:
  (any field name)  video file (webm, etc.)  required
```

**Response `200`**

```json
{ "url": "/api/v1/recordings/abc123.webm" }
```


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


### `GET /api/v1/recordings/:filename`

Download a recording file. Returns `404` for expired files.


## Agents

### `GET /api/v1/agents`

Return the names of agents that have resource samples on record. Samples are kept for 30 days, so an agent that is not connected now can still appear.

**Response `200`**

```json
["mac-mini-office", "mac-mini-lab"]
```


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


## Sessions

Find a `sessionId` in the MCP server's `list_devices` result. Both endpoints take the session cookie or a PAT with the `view` scope.

### `GET /api/v1/sessions/:sessionId/screenshot`

Return the session device's current screen as an image.

```
Query:
  format  png|jpeg  optional (default: png)
```

**Response `200`**: an `image/png` or `image/jpeg` body

Returns `404` when the session does not exist, `409` when the device is shut down, `502` when the agent is offline or the capture fails, and `504` when there is no answer within 10 seconds.


### `GET /api/v1/sessions/:sessionId/ui-tree`

Return the UI elements on the session device's current screen.

**Response `200`**

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

`frame` is a 0–1 fraction of the screen size. The error status codes match the screenshot endpoint, with a 15-second timeout.


## Relay

### `GET /api/v1/relay/host`

Return the relay address details the dashboard uses to build addresses for teammates. Requires sign-in.

**Response `200`**

```json
{
  "lanHost": "192.168.0.10",
  "port": 4000,
  "publicBaseUrl": "https://tap.example.com",
  "agentRelayUrl": "wss://tap.example.com"
}
```

A value that cannot be determined is `null`. `lanHost` is always `null` when the relay runs in a container.


## Logs

### `GET /api/v1/logs`

Return the relay's in-memory log buffer (last 500 lines). Only requests from the relay host are answered. Another machine, a tunnel, or a remote client behind a trusted proxy gets `403`, signed in or not. To read the logs from elsewhere, look at the relay host's own output (terminal, `journalctl`, `docker compose logs`).

```
Query:
  lines  number  optional (an integer from 1 to 500, default: 100). A non-number means 100; a value out of range is clamped to the nearest end.
```

**Response `403`**

```json
{ "error": "Logs are only available on the relay host. Run `tapflow logs` there." }
```

**Response `200`**

```json
[
  "[2025-05-15T12:00:00.000Z] ..."
]
```
