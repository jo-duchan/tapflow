# Quick Start

Get tapflow running in under 10 minutes.

## 1. Deploy the relay

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

```sh
tapflow deploy
# ? Cloud provider: fly.io / AWS / self-hosted
# ✓ Relay deployed: wss://relay.myteam.example.com
```

## 2. Set up iOS agent (Mac)

Run this once on the Mac that will serve as the iOS agent:

```sh
tapflow ios setup
# Detects Xcode SDK, downloads matching Simulator Runtime if needed,
# downloads and builds WebDriverAgent (~2 min)
```

## 3. Start the agent

```sh
tapflow agent start --relay wss://relay.myteam.example.com
# ✓ iOS Agent connected (3 simulators available)
```

## 4. Invite your QA team

```sh
tapflow invite qa@company.com
# An invitation email is sent automatically
```

Open the dashboard URL (`https://relay.myteam.example.com`) and sign in.

## 5. Upload a build

```sh
# iOS — build with xcodebuild -sdk iphonesimulator, then zip the .app bundle
tapflow upload MyApp.app.zip --token <pat>

# Android
tapflow upload MyApp.apk --token <pat>
```

Your QA team can now pick a build, select a device, and start a session.
