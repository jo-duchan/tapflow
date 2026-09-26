# Dashboard Overview

A quick reference for every section in the tapflow dashboard.

## App Center

**Route**: `/app-center`

The main workspace for the team. Shows all uploaded builds organised by app.

| UI element | What it does |
|---|---|
| App list | Groups builds by app (bundle ID + platform). Select an app to see its builds, grouped by version. Use **Add App** to add an app by hand. |
| Build row | Shows build number, platform, status badge, uploader, and upload date. Click it to open the QA Session page for that build. |
| Status | **Backlog** · **In Progress** · **Done** · **Rejected** — change it from the status menu on the build row. A Viewer sees the status badge only, with no status menu and no schedule-deletion button. |
| Upload build | Opens the build upload dialog. Accepts `.app.zip` or `.tar.gz`/`.tgz` (iOS simulator builds) and `.apk` (Android). |

Viewer is read-only. When a Viewer presses **Add App** or **Upload build**, a notice says QA or Developer access is needed instead of opening the dialog. For what each role can do, see [Invite your team](/dashboard/setup#_3-invite-your-team).

## QA Session

**Route**: `/app-center/build`

The full-screen device view. Opened when you click a build row in App Center. Pick a Mac under **Select Mac**, then click a device under **Select device** to start a session. The device list shows each device as **Booted**, **Available**, or **In use** (another teammate has it). Use the breadcrumb at the top to go back a step.

| Control | Description |
|---|---|
| Touch | Click or tap anywhere on the simulator to send a touch event. |
| Swipe | Click and drag to swipe. |
| Pinch | Hold Option (Alt) and drag. |
| Device buttons | The toolbar buttons differ by platform. iOS has **Home** and a software keyboard button; Android has **Home**, **Back**, **Recent Apps**, and volume and power buttons. |
| Deep link | Enter a deep link URL to open a specific screen in the app directly. |
| Start / Stop recording | Start and stop recording from the toolbar. Recordings collect per build in the **Recordings** tab and can be downloaded. |
| Comments | Leave threaded comments on the build in the **Comments** tab. You can attach images, and comments are visible to the whole team. |

The screen streams at ~30 fps. Frame rate adapts to your network automatically.

::: info Recording retention
Recordings are kept for **72 hours** after creation. Download them before they expire if you need them long-term.
:::

## Mac Resources

**Route**: `/mac-resources`

CPU and RAM usage for each Mac agent. Useful for spotting overloaded hosts before assigning more sessions.

| Element | Description |
|---|---|
| Mac list | Macs that are connected now or have reported usage in the last 30 days, by hostname. A green dot marks a Mac whose agent is connected; select a Mac to show its charts. |
| Time-series chart | Historical CPU % (blue) and RAM % (purple). |
| Range selector | **1h** / **6h** / **24h** / **7d** — switches the visible window. |

Data is sampled once per minute and retained for 30 days.

## Settings

Settings has three sub-pages accessible from the left nav.

### Default

Personal profile settings for the currently signed-in user.

- **Workspace** — the team name and logo. Visible to Admins only.
- **Apps** — rename or delete apps. Visible to Admins, Developers and QA, hidden from Viewers.
- **Nickname** — shown in comments and session history.
- **Avatar** — click the pencil icon on the avatar to upload a new image (PNG or JPEG, max 2 MB).
- **Change password** — requires current password.

### Team

Visible to **Admin** only.

- **Members list** — all accounts with email, role, and join date.
- **Invite member** — send an email invite or generate a copy-paste link. Invites expire after 7 days.
- **Change role** — reassign any member's role (Admin / Developer / QA / Viewer).
- **Remove member** — permanently deletes the account. You cannot remove yourself.
- **Reset pwd** — send a password reset email to a specific member. Requires SMTP.

### Tokens

Personal access tokens (PATs) for CI/CD scripts and API access. The sidebar shows this page to **Admin** only.

- **New token** — enter a name, an **Expiration**, and a Type. Choose 7, 30, 60 or 90 days, a custom number (1–365 days), or **No expiration**; the default is 30 days. A token with no expiration stays valid until you revoke it, so keep CI tokens to 90 days or less. The list marks these tokens **No expiration** so you can find and clean them up. **API** is for CI uploads and API access (scope `view, builds:write`); **Agent** connects remote Mac agents. The token is shown once — copy it immediately.
- **Revoke** — instantly invalidates the token.

Use PATs with the `Authorization: Bearer tflw_pat_<token>` header to upload builds from CI. See [Uploading Builds](/testing/app-center).
