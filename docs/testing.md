---
title: Test apps
description: "How teammates test builds in the browser: pick a build in App Center, drive a simulator or emulator in a QA Session, and leave what you found."
---

<a id="dashboard-overview"></a>

# Test apps

This section is for teammates who check builds in the browser. tapflow itself needs nothing installed: all you need is the tapflow dashboard address and an account from whoever runs tapflow. If they open the dashboard to you through Tailscale, install the Tailscale app too ([Tailscale](/operate/external-access#tailscale-recommended)).

The dashboard is tapflow's web interface. The devices (iOS simulators and Android emulators) run on a Mac your operator set up, and you watch and drive them from your browser.

## Testing flow {#testing-flow}

1. Pick an app and a build in **App Center**. App Center is the dashboard's build list, unrelated to Microsoft App Center.
2. Press **Start QA** on the build's row to open a QA Session. A QA Session streams the device screen to your browser and sends your clicks and keystrokes to the device.
3. Pick a Mac and a device, and the build is installed on it. Launch the app, check it, and leave what you found as a comment or a recording.
4. Change the build's review status in App Center to tell the team the result.

## Pages in this section {#pages}

- [App Center](/testing/app-center): the build list, uploading builds, search and status filter, review status, and scheduled deletion.
- [QA Session](/testing/qa-session): picking a Mac and a device to start a session, and everything you can do in one.
  - [Device controls](/testing/device-controls): touch, swipe, pinch, typing, device buttons, rotation, restart, and the clipboard.
  - [Deep links](/testing/deep-links): open a specific screen of the app from a URL.
  - [Network control](/testing/network-control): take the device offline and bring it back.
  - [Audio](/testing/audio): hear the device in your browser.
  - [Screenshots & recordings](/testing/screenshots-and-recordings): save the screen as an image or record it as a video.
  - [Comments](/testing/comments): leave notes and images on a build for the team.
  - [Flow Capture](/testing/flow-capture): save the steps you took in a session as a flow YAML.

## Moved sections {#moved-sections}

Sections that used to be on this page now live on these pages.

- [App Center](/testing/app-center)
  - <a id="app-center" data-moved-to="/testing/app-center#app-center"></a>[App Center](/testing/app-center#app-center)
- [QA Session](/testing/qa-session)
  - <a id="qa-session" data-moved-to="/testing/qa-session#qa-session"></a>[QA Session](/testing/qa-session#qa-session)
- [Scaling Mac Resources](/operate/scaling)
  - <a id="mac-resources" data-moved-to="/operate/scaling#mac-resources"></a>[Mac Resources](/operate/scaling#mac-resources)
- [Team, roles & tokens](/operate/team-and-roles)
  - <a id="settings" data-moved-to="/operate/team-and-roles"></a>[Settings](/operate/team-and-roles)
  - <a id="team" data-moved-to="/operate/team-and-roles#team"></a>[Team](/operate/team-and-roles#team)
  - <a id="tokens" data-moved-to="/operate/team-and-roles#tokens"></a>[Tokens](/operate/team-and-roles#tokens)
- [For teammates](/get-started/teammates)
  - <a id="default" data-moved-to="/get-started/teammates#default"></a>[Default](/get-started/teammates#default)
