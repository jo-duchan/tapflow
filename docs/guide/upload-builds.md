# Uploading Builds

Upload iOS or Android builds so your QA team can install them on any simulator.

## Manual upload (CLI)

First, generate a Personal Access Token in **Settings → Tokens**.

```sh
# iOS — zip the .app bundle produced by xcodebuild -sdk iphonesimulator
tapflow upload MyApp.app.zip --token tflw_pat_xxx

# Android
tapflow upload MyApp.apk --token tflw_pat_xxx
```

## GitHub Actions

```yaml
- name: Upload to tapflow
  run: |
    npx tapflow upload ${{ env.APP_PATH }} \
      --relay ${{ secrets.TAPFLOW_RELAY_URL }} \
      --token ${{ secrets.TAPFLOW_PAT }} \
      --status "In Progress"
```

## What happens on upload

1. The relay extracts metadata from the binary:
   - iOS: reads `Info.plist` → `CFBundleIdentifier`, `CFBundleShortVersionString`, `CFBundleVersion`
   - Android: reads `AndroidManifest.xml` via `aapt`
2. An **App** entry is created automatically if one with the same bundle ID doesn't exist.
3. A **Build** entry is created under the App.
4. QA team sees the new build in App Center immediately.

## Build statuses

| Status | Meaning |
|--------|---------|
| Backlog | Not ready for testing |
| In Progress | Under active development |
| Done | QA passed |
| Rejected | Needs fixes |
