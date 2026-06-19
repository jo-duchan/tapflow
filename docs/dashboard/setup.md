# First-time Setup

Walks through the steps to configure tapflow on a fresh relay for the first time.

::: tip The relay must be running first
If you haven't set up the relay yet, see [Self-Hosting the Relay](/guide/self-hosting) first.
:::

## 1. Create the admin account

tapflow has no default credentials. On first launch, the dashboard automatically redirects to the setup page.

1. Open `http://localhost:4000` (or your relay URL) in any browser.
2. You are redirected to `/setup` automatically.
3. Enter your email and a password (minimum 8 characters).
4. Click **Create admin account**.

::: warning One-time only
The setup page only appears when no accounts exist. After this step, use **Settings → Team** to invite additional users.
:::

::: tip Headless server or CI?
If a browser is not available, use `tapflow admin init` to create the first admin account via CLI. The relay must be running first.
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

## 6. Share access with your team

Now hand off access so the team can test on their own. Teammates don't install tapflow — all they need is a browser.

**Send the right URL.** The URL you share depends on the deployment (`localhost` only works on the relay Mac itself, so it can't be shared).

| Deployment | URL teammates open |
|------------|--------------------|
| Same office network | The relay Mac's LAN IP, e.g. `http://192.168.0.10:4000` |
| Tailscale tunnel | The tailnet URL printed in the startup banner (teammates need Tailscale installed too) |
| VPS + rathole tunnel | The public URL printed in the startup banner, e.g. `https://your-vps.com` |

See [Self-Hosting the Relay](/guide/self-hosting) for the details of each deployment. Which path a teammate connects over also decides the stream quality they get — on the same LAN, plain HTTP gives the **Standard** profile, while HTTPS gives the **Smooth** profile. See [Streaming Quality](/guide/streaming) for the profile each setup maps to.

**Have them accept the invite.** When a teammate accepts the invitation you sent in [step 3](#_3-invite-your-team), they set a password and sign in. If SMTP isn't configured, share the invite link directly.

**What teammates do.** Once signed in, a teammate can test without installing anything:

1. Pick a build in App Center.
2. Click a device card to start a session.
3. Control the simulator or emulator in the browser and leave feedback as comments on the build.

What each person can do depends on the role you assigned when inviting them (Admin / Developer / QA / Viewer). See [3. Invite your team](#_3-invite-your-team) above for the role descriptions.

**Next:** Learn what each dashboard section does → [Dashboard Overview](/dashboard/overview)
