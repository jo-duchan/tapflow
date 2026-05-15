# REST API

All endpoints are served by the relay at `http(s)://<relay-host>/api/v1/`.

Authentication: session cookie (dashboard users) or `Authorization: Bearer <pat>` header (CI/CD).

## Builds

### `POST /api/v1/builds`

Upload a build.

```
Content-Type: multipart/form-data
Authorization: Bearer tflw_pat_<token>

Fields:
  file      .app.zip (iOS) or .apk (Android) — max 500 MB
  status    optional — Backlog | In Progress | Done | Rejected
```

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

### `GET /api/v1/builds`

List builds, optionally filtered by `app_id`.

```
GET /api/v1/builds?app_id=7
```

## Apps

### `GET /api/v1/apps`

List all apps.

## Agents (resource monitoring)

### `GET /api/v1/agents`

List all known agent names.

### `GET /api/v1/agents/:name/resources`

Get CPU/RAM time-series for a specific agent.

```
GET /api/v1/agents/mac-mini-office/resources?range=1h
```

| `range` | Description |
|---------|-------------|
| `1h` | Last 1 hour |
| `6h` | Last 6 hours |
| `24h` | Last 24 hours |
| `7d` | Last 7 days |

**Response `200`**

```json
[
  { "cpu_percent": 44.2, "mem_percent": 61.0, "recorded_at": "2025-05-15T12:00:00Z" },
  ...
]
```
