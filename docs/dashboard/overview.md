# Dashboard Overview

A quick reference for every section in the tapflow dashboard.

## App Center

**Route**: `/app-center`

The main workspace for QA. Shows all uploaded builds organised by app.

| UI element | What it does |
|---|---|
| App card | Groups builds by app (bundle ID + platform). Click to expand build list. |
| Build row | Shows version, build number, status badge, upload date, and uploader. |
| Status badge | **Backlog** · **In Progress** · **Done** · **Rejected** — click to change (Developer or Admin). |
| Upload Build | Opens the build upload dialog. Accepts `.app.zip` (iOS) or `.apk` (Android). |
| Comments | Threaded comments per build. Attach screenshots. Visible to the whole team. |
| Device card | Shows available simulators. **●** = booted, **○** = available. Click to start a session. |

## QA Session

**Route**: `/app-center/build`

The full-screen simulator view. Opened when you click a device card in App Center.

| Control | Description |
|---|---|
| Touch | Click or tap anywhere on the simulator to send a touch event. |
| Swipe | Click and drag to swipe. |
| Pinch | Two-finger pinch gesture on trackpad. |
| Home / Back | Buttons in the control bar (platform-specific). |
| FPS indicator | Shows current frames-per-second in the top-right corner. |
| End session | Disconnects your browser from the device and returns the device to available state. |

The screen streams as JPEG frames at ~30 fps. Frame rate adapts to your network automatically.

## Mac Resources

**Route**: `/mac-resources`

CPU and RAM usage for every connected Mac agent. Useful for spotting overloaded hosts before assigning more sessions.

| Element | Description |
|---|---|
| Agent card | One card per connected Mac. Shows hostname and current CPU / RAM. |
| Time-series chart | Historical CPU % (blue) and RAM % (gray). |
| Range selector | **1h** / **6h** / **24h** / **7d** — switches the visible window. |

Data is sampled once per minute and retained for 30 days.

## Settings

Settings has three sub-pages accessible from the left nav.

### Default

Personal profile settings for the currently signed-in user.

- **Display name** — shown in comments and session history.
- **Avatar** — click the pencil icon on the avatar to upload a new image (PNG or JPEG, max 2 MB).
- **Change password** — requires current password.

### Team

Visible to **Admin** only.

- **Members list** — all accounts with email, role, and join date.
- **Invite member** — send an email invite or generate a copy-paste link. Invites expire after 7 days.
- **Change role** — reassign any member's role (Admin / Developer / QA / Viewer).
- **Remove member** — permanently deletes the account. You cannot remove yourself.

### Tokens

Personal Access Tokens (PATs) for CI/CD scripts and API access.

- **Create token** — enter a name and optional expiry. The token is shown once — copy it immediately.
- **Revoke** — instantly invalidates the token.

Use PATs with the `Authorization: Bearer tflw_pat_<token>` header to upload builds from CI. See [Uploading Builds (CI/CD)](/guide/upload-builds).
