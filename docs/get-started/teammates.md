---
title: For teammates
description: For a teammate who received a tapflow invite link. Accept it in the browser with nothing to install, pick a build in App Center and drive the device in a QA Session. Also covers what each role may do and your profile settings.
---

# For teammates

If someone on your team sent you a tapflow invite link, follow this page. You install nothing: the iOS simulators and Android emulators run on a Mac the operator set up, and you see and drive their screens in your browser. By the end you will have picked a build in App Center and tapped its screen yourself.

::: info Before you begin
- **A current browser**: Chrome, Firefox, Safari or Edge.
- **An invite link**: an Admin on your team creates it in the dashboard and sends it to you. The person who installed and runs tapflow (the operator) is the first Admin, but any member with the Admin role can invite. It is valid for 7 days from when it was created.
- **The Tailscale app** (only if the operator uses Tailscale): install Tailscale on your computer and join the same tailnet as the operator, or the dashboard will not open. See [Tailscale](/operate/external-access#tailscale-recommended).
:::

<a id="_6-share-access-with-your-team"></a>

## 1. Accept the invite {#accept-the-invite}

1. Open the invite link in your browser. The **Set up your account** page shows the role the inviting Admin chose after **You're joining as**.
2. **Nickname** and **Avatar** are optional. Your nickname is the name shown on your comments; an avatar is a PNG or JPEG image of 2 MB or less.
3. Enter **Password** (at least 8 characters) and **Confirm password**, then click **Create account**. You are signed in and App Center opens.

If the invite page does not load, check your case in the [address table](#bookmark-the-address) below, or ask whoever runs tapflow.

If the link shows **Invitation expired**, it has expired or has already been used. Ask an Admin for a new one. See [Sign-in & accounts](/troubleshooting/accounts).

## 2. Save the dashboard address {#bookmark-the-address}

The dashboard address is the part of the invite link before `/invite`. If the link is `http://192.168.0.10:4000/invite?token=…`, the address is `http://192.168.0.10:4000`. Bookmark it; next time, open it, enter **Email** and **Password**, and click **Sign in**. A sign-in lasts 7 days.

What the address looks like depends on how the operator set tapflow up.

| Operator's setup | Address you open |
|---|---|
| Same office network | The operator's Mac on the LAN, e.g. `http://192.168.0.10:4000` |
| Tailscale | A tailnet address. Tailscale must be running on your computer too |
| VPS tunnel | A public address, e.g. `https://your-vps.com` |

An address with `localhost` in it only opens on the operator's own Mac. If that is what you received, ask the operator again.

## 3. Test a build {#test-a-build}

1. In App Center, pick the app in the **Apps** list on the left. The first app in the list is selected when the page opens, so check it when there are several.
2. Find the build to test. The **Search version or label…** box and the status filter narrow the list.
3. Click **Start QA** on the build's row. The button is off for a build whose review status is **Done**.
4. Pick a Mac on the **Select Mac** page, then click a device on the **Select device** page. A device a teammate is using shows **In use** and cannot be picked.
5. Once the device is up and the build has installed, click **Launch app** in the toolbar to open the app.

A click on the device screen is a tap, and a drag is a swipe. To type, click the device screen once and then type. See [Device controls](/testing/device-controls) for the rest.

## 4. Leave what you found {#leave-feedback}

Write what you found as a [comment](/testing/comments) on the build; everyone who opens the same build sees it. A comment can carry an image, and you can also keep the screen as a [screenshot or recording](/testing/screenshots-and-recordings).

## What each role can do {#roles}

Every account has the role the inviting Admin chose. Only an Admin can change it.

| Role | What it can do |
|---|---|
| Viewer | Views builds, tests them in a QA Session, and leaves comments and recordings. Apart from comments and recordings it is read-only: no uploading builds, changing review status or managing apps. |
| QA, Developer | Everything a Viewer does, plus uploading builds, changing review status, scheduling build deletion, adding, editing and deleting apps, and managing webhooks. The two roles have the same permissions. |
| Admin | Everything. Inviting members, changing their roles, removing them, resetting passwords, workspace settings and tokens are Admin-only. |

When a Viewer clicks **Upload build** or **Add App**, a notice says QA or Developer access is needed. For roles and member management in full, see [Team, roles & tokens](/operate/team-and-roles).

<a id="default"></a>

## Profile settings {#profile}

Click your name at the bottom of the sidebar and choose **Settings**.

- **Profile**: change **Nickname** and **Avatar**, then click **Save changes**.
- **Password**: enter **Current password**, **New password** and **Confirm new password**.

If you forget your password, ask an Admin. The Admin clicks **Reset pwd** in **Settings → Team** and sends you the reset link it shows. When tapflow can send email (SMTP is set up), the link also arrives by email. The link works once, for 2 hours. After the reset you are signed out everywhere, so sign in again with the new password. **Log out** is in the same menu.

## Next steps {#next-steps}

- [Test apps](/testing): every feature App Center and a QA Session offer.
- [QA Session](/testing/qa-session): picking a Mac and a device, the info card, and why a session ends.
- [App Center](/testing/app-center): the build list, review status, search and filters.
- [Sign-in & accounts](/troubleshooting/accounts): what to do when an invite or password-reset link has expired.
