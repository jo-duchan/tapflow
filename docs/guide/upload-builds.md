# Uploading Builds

Upload iOS or Android builds so your QA team can install them on any simulator.

## Dashboard upload

In the App Center, click **Upload Build** and select your file.

- iOS: `.app.zip` (zip the `.app` bundle built with `xcodebuild -sdk iphonesimulator`)
- Android: `.apk`

## API upload (CI/CD)

First, generate a Personal Access Token in **Settings → Tokens**.

```sh
# iOS
curl -X POST https://your-relay/api/v1/builds \
  -H "Authorization: Bearer tflw_pat_xxx" \
  -F "file=@MyApp.app.zip" \
  -F "status=In Progress"

# Android
curl -X POST https://your-relay/api/v1/builds \
  -H "Authorization: Bearer tflw_pat_xxx" \
  -F "file=@MyApp.apk"
```

## GitHub Actions example

```yaml
- name: Upload to tapflow
  run: |
    curl -X POST ${{ secrets.TAPFLOW_RELAY_URL }}/api/v1/builds \
      -H "Authorization: Bearer ${{ secrets.TAPFLOW_PAT }}" \
      -F "file=@MyApp.app.zip" \
      -F "status=In Progress"
```

## What happens on upload

1. The relay extracts metadata from the binary:
   - iOS: reads `Info.plist` → `CFBundleIdentifier`, `CFBundleShortVersionString`, `CFBundleVersion`
   - Android: reads `AndroidManifest.xml`
2. An **App** entry is looked up by bundle ID:
   - First upload → App created automatically.
   - Same bundle ID, same platform → existing App reused.
   - Same bundle ID, different platform → App platform upgraded to `both` (iOS + Android grouped under one App).
3. A **Build** entry is created under the App.
4. QA team sees the new build in App Center immediately.

## Build statuses

| Status | Meaning |
|--------|---------|
| Backlog | Not ready for testing |
| In Progress | Under active development |
| Done | QA passed |
| Rejected | Needs fixes |
