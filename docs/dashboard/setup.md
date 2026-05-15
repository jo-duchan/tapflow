# First-time Setup

This guide walks through the steps to go from a fresh relay to a fully operational tapflow dashboard — the first time only.

## 1. Start the relay

On your Mac, run:

```sh
tapflow start
# ✓ Relay started on ws://localhost:4000
# ✓ iOS Agent connected (3 simulators available)
```

The relay is now running at `http://localhost:4000`.

## 2. Create the admin account

tapflow has no default credentials. Create the first admin account:

```sh
tapflow init
  ? Admin email: admin@yourteam.com
  ? Password: ********
  ✓ Admin account created
  →  Open http://localhost:4000 to sign in
```

::: tip Remote relay
If your relay runs on a separate server, pass its URL:
```sh
tapflow init --relay https://your-relay-url
```
:::

::: warning One-time only
`tapflow init` only works when no accounts exist yet. After this step, use **Settings → Team** to invite additional users.
:::

## 3. Sign in

Open `http://localhost:4000` (or your relay URL) in any browser. Sign in with the email and password you just created.

## 4. Invite your team

Once signed in as Admin, go to **Settings → Team** and send invitations:

1. Click **Invite member**.
2. Enter the team member's email and select a role:
   - **Admin** — full access, can invite and remove members.
   - **Developer** — can upload builds and manage apps.
   - **QA** — can start sessions and leave comments.
   - **Viewer** — read-only access to builds and recordings.
3. Click **Send invite**. The member receives an email with a link to set their password.

::: tip No email server yet?
If SMTP isn't configured, copy the invite link from the response and share it directly. See [Configuration](/reference/configuration) to set up SMTP.
:::

## 5. Upload your first build

Go to **App Center** and click **Upload Build**:

- **iOS**: upload a `.app.zip` — zip your `.app` bundle built with `xcodebuild -sdk iphonesimulator`.
- **Android**: upload a `.apk`.

tapflow reads the bundle ID, version, and build number automatically and creates an App entry.

## 6. Start a session

From App Center, select a build and click a device card to start a session. The device streams to your browser in real time.

---

**Next:** Learn what each dashboard section does → [Dashboard Overview](/dashboard/overview)
