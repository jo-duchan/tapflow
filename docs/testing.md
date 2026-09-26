---
title: Test apps
description: "Where teammates test builds in the dashboard: App Center lists the uploaded builds, and a QA Session streams a device to your browser."
---

<a id="dashboard-overview"></a>

# Test apps

Teammates test builds in two dashboard screens: App Center, which lists the uploaded builds, and the QA Session, which streams a device to the browser.

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

## Moved sections {#moved-sections}

Sections that used to be on this page now live on these pages.

- [QA Session](/testing/qa-session)
  - <a id="qa-session" data-moved-to="/testing/qa-session#qa-session"></a>[QA Session](/testing/qa-session#qa-session)
- [Scaling Mac Resources](/operate/scaling)
  - <a id="mac-resources" data-moved-to="/operate/scaling#mac-resources"></a>[Mac Resources](/operate/scaling#mac-resources)
- [Team, roles & tokens](/operate/team-and-roles)
  - <a id="settings" data-moved-to="/operate/team-and-roles"></a>[Settings](/operate/team-and-roles)
  - <a id="default" data-moved-to="/operate/team-and-roles#default"></a>[Default](/operate/team-and-roles#default)
  - <a id="team" data-moved-to="/operate/team-and-roles#team"></a>[Team](/operate/team-and-roles#team)
  - <a id="tokens" data-moved-to="/operate/team-and-roles#tokens"></a>[Tokens](/operate/team-and-roles#tokens)
