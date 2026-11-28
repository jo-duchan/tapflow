---
title: Quick Start
description: The operator's tutorial. Install tapflow on one Mac, create the admin account, upload the build you already have and tap its screen for the first time. Ends with inviting a teammate and sending them the dashboard address.
---

<a id="first-time-setup"></a>

# Quick Start

This page takes you from installing tapflow on one Mac to tapping your own build's screen in the browser. The last step invites a teammate to test the same build. If someone on your team sent you an invite link, you have nothing to install — go to [For teammates](/get-started/teammates).

::: info Before you begin
- **An Apple Silicon (M-series) Mac**: Intel Macs are not supported. See [Requirements](/operate/requirements) for the supported macOS and Xcode versions.
- **Node.js 22 or later**
- **The Mac's administrator password**: `tapflow setup` asks for your sudo password when it installs Homebrew and the JDK, and while it finishes setting up Xcode.
- **An Apple account**: you sign in with one to download Xcode, from the App Store or from Apple's developer site.
- **A build to test**: a simulator `.app.zip` or `.tar.gz`/`.tgz` for iOS, an `.apk` for Android. A device `.ipa` cannot be uploaded. An Android APK needs the `arm64-v8a` ABI to install on an Apple Silicon emulator. If you have no build yet, ask your app's developers for a simulator or emulator build; [Upload from CI](/operate/ci-distribution) shows how CI can produce and upload one.
- **Time**: most of it is `tapflow setup` downloading. Xcode, the simulator runtime, the Android SDK and its system image are large, so a first download takes as long as your network needs. When they are already installed, setup only checks them.
:::

## 1. Install tapflow {#_1-install-tapflow}

::: code-group

```sh [npm]
npm install -g tapflow
```

```sh [yarn]
yarn global add tapflow
```

```sh [pnpm]
pnpm add -g tapflow
```

:::

## 2. Set up the environment {#_2-set-up-the-environment}

On the Mac that will run the simulators and emulators, install what they need in one step:

```sh
tapflow setup
```

Setup asks before each step that installs something. Setup cannot install Xcode itself, so it opens the App Store for you; press Enter once Xcode is installed and it carries on. Xcode is also available from [Apple's developer site](https://developer.apple.com/xcode/). During the iOS steps, macOS may show two prompts:

- **Audio recording permission**: needed to send the device's sound to the browser. Click **Allow**.
- **System extension approval**: the network filter used for iOS network control is a system extension, and macOS asks you to approve it. Without the approval setup ends with `SETUP INCOMPLETE` and names what is left. Everything except network control works without it.

To set up one platform only, run `tapflow setup ios` or `tapflow setup android`.

When setup finishes, run `tapflow doctor` to confirm. See [Environment Setup](/operate/environment-setup) for what each step does.

## 3. Configure tapflow (optional) {#_3-configure-tapflow-optional}

Skip this step if the defaults are fine: port 4000, no tunnel, HTTP. Run it only when you need a tunnel for access from outside the office, or HTTPS.

```sh
tapflow init
```

It asks about a tunnel, streaming performance (HTTP or HTTPS) and Lean mode. For what each question sets and where the configuration is written, see [Configuring tapflow](/operate/configure).

## 4. Start the relay and agent {#_4-start-the-relay-agent}

On the same Mac, run:

```sh
tapflow start
```

It prints the install, config and data paths first, then a banner like the one below once the relay and agent are ready. If an Android environment is present, an `android` agent connects too. If the first agent fails to connect, `start` stops with an error banner; an agent that fails after another has connected is reported on a ⚠ line and the rest keep running.

```text
  →  Relay started on http://localhost:4000

  ✓  Connecting ios agent…

  ┌─────────────────────────────────────────────┐
  │  ✓  TAPFLOW READY                           │
  └─────────────────────────────────────────────┘
     Relay  : http://localhost:4000
     Open http://localhost:4000 in your browser.
     Press Ctrl+C to stop.
```

Leave this terminal open. `Ctrl+C` stops the relay and the agent together.

::: tip Running the relay on another server
Use `tapflow relay start` and `tapflow agent start`. See [Deployment options](/operate/deployment).
:::

<a id="_1-create-the-admin-account"></a>

## 5. Create the admin account {#_5-create-the-admin-account}

tapflow has no default account. The first account gets the Admin role, and you create it in a browser on this Mac.

1. On this Mac, open `http://localhost:4000` in a browser. With no accounts yet, you land on the **Set up tapflow** page (`/setup`).
2. Enter **Admin email**, **Password** (at least 8 characters) and **Confirm password**.
3. Click **Create admin account**. You are taken to the sign-in page.

<a id="_2-sign-in"></a>
<a id="_6-open-the-dashboard"></a>

On the sign-in page, enter the email and password you just created and click **Sign in**. App Center opens.

::: warning The first account can only be created on this Mac
Opened from another computer, the page shows no form and tells you to run `tapflow admin init` on this Mac instead. The setup page appears only while no account exists; every later account comes from an invitation.
:::

::: tip A server without a browser
Run `tapflow admin init` in a terminal; it asks for an email and a password and creates the admin account. The relay must be running first. For an install nobody can type into, set `TAPFLOW_ADMIN_EMAIL` and `TAPFLOW_ADMIN_PASSWORD` and the relay creates the account as it starts. See [Configuration](/reference/configuration#create-the-first-admin-account-in-a-docker-container-tapflow-admin-email).
:::

<a id="_4-add-your-first-app"></a>

## 6. Upload your build {#upload-your-build}

1. In App Center, click **Upload build** at the top right.
2. Click the **File** area to choose your build, or drop the file onto it.
3. Click **Upload**. A **Build uploaded** notice appears and the build joins the list.

tapflow reads the bundle ID, version and build number from the file and creates the app entry for you. For review status, adding an app before its first build, and uploading from CI, see [App Center](/testing/app-center#upload-a-build).

<a id="_5-start-a-session"></a>

## 7. Start a QA Session {#start-a-session}

1. On the build you just uploaded, click **Start QA**.
2. On the **Select Mac** page, pick this Mac's card.
3. On the **Select device** page, click a device. An **Available** device boots when you pick it.

Once the device is up, the build installs on its own. The info card beside the device shows **Starting device…**, then **Installing app…**. See [QA Session](/testing/qa-session) for each page in detail.

## 8. Tap the device {#first-tap}

When the install finishes, a **Launch app** button appears in the toolbar. Click it to open your app.

Now a click on the device screen is a tap, and a drag is a swipe. To type, click the device screen once and then type. If your app responds, the setup is done. See [Device controls](/testing/device-controls) for everything else you can do.

## 9. Invite a teammate {#invite-a-teammate}

Teammates install nothing. One invite link is all they need to sign up and test in their browser.

1. In the dashboard sidebar, open **Team** under **Settings**. Only Admins see it.
2. Click **Invite member**, then set **Email** and **Role**. The role defaults to **QA**.
3. Click **Generate invite link**. The link appears in the dialog.
4. Send it to your teammate over chat or email. It is valid for 7 days.

When you opened the dashboard at `http://localhost:4000` on this Mac, the invite link carries this Mac's LAN address instead of `localhost`. The part before `/invite` (for example `http://192.168.0.10:4000`) is the dashboard address your teammate uses from then on. If you set up a tunnel with `tapflow init`, the address on the startup banner's `Public :` line goes in instead. Without a tunnel, a `relay.url` in your configuration file does.

A teammate outside your network needs a tunnel to reach the relay; see [External access](/operate/external-access). What each role may do, and managing members, is in [Team, roles & tokens](/operate/team-and-roles#invite-teammates).

## Next steps {#next-steps}

- [For teammates](/get-started/teammates): how an invited teammate signs up and tests. Send it along with the link.
- [Manual QA](/testing): everything a QA Session offers — deep links, network control, recordings, comments and more.
- [Upload from CI](/operate/ci-distribution): let CI upload builds instead of doing it by hand.
- [Deployment options](/operate/deployment): run the relay on its own host, or add more Macs.
- [Troubleshooting](/troubleshooting): when an install or a connection gets stuck, find the symptom here, along with your `tapflow doctor` output.

## Moved sections {#moved-sections}

The rest of the former First-time Setup page (`/dashboard/setup`) moved to these pages.

- [Team, roles & tokens](/operate/team-and-roles)
  - <a id="_3-invite-your-team" data-moved-to="/operate/team-and-roles#_3-invite-your-team"></a>[Invite your team](/operate/team-and-roles#_3-invite-your-team)
- [For teammates](/get-started/teammates)
  - <a id="_6-share-access-with-your-team" data-moved-to="/get-started/teammates#_6-share-access-with-your-team"></a>[Share access with your team](/get-started/teammates#_6-share-access-with-your-team)
