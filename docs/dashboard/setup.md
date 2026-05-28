# First-time Setup

Walks through the steps to configure tapflow on a fresh relay for the first time.

::: tip The relay must be running first
If you haven't set up the relay yet, see [Self-Hosting the Relay](/guide/self-hosting) first.
:::

## 1. Create the admin account

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

## 2. Sign in

Open `http://localhost:4000` (or your relay URL) in any browser. Sign in with the email and password you just created.

## 3. Invite your team

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

## 4. Add your first app

Go to **App Center**. There are two ways to add an app:

**Option A — Upload a build**: Click **Upload Build** and select your file. tapflow reads the bundle ID, version, and build number automatically and creates the App entry.

- iOS: `.app.zip`
- Android: `.apk`

**Option B — Add App manually**: Click **+ Add App** in the sidebar and enter the app name, bundle ID, and platform. Use this to pre-register an app before any build is ready.

If an App with the same bundle ID already exists for the other platform, the two are grouped under a single App entry (`both`).

## 5. Start a session

From App Center, select a build and click a device card to start a session. The device streams to your browser in real time.

**Next:** Learn what each dashboard section does → [Dashboard Overview](/dashboard/overview)
