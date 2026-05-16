# Uploading Builds

Upload iOS or Android builds so your QA team can test them.

## Dashboard upload

In App Center, click **Upload Build** and select your file.

- iOS: `.app.zip` — simulator binary ([how to build from command line](https://developer.apple.com/library/archive/technotes/tn2339/_index.html))
- Android: `.apk`

::: warning iOS — `.ipa` files are not supported
`.ipa` is the format for real devices. tapflow only accepts `.app.zip` for simulators. If you get an upload error, see [Troubleshooting](/guide/troubleshooting#ios-build-upload-errors).
:::

On upload, the build is linked to an App by bundle ID. If no matching App exists, one is created automatically. You can also create the App first and link builds to it later.

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

### Optional fields

| Field | Description |
|-------|-------------|
| `status` | `Backlog` \| `In Progress` \| `Done` \| `Rejected` |
| `label` | Custom label shown on the build (e.g. `"rc-1"`, `"hotfix"`) |
| `app_id` | Explicitly link to an existing App. Omit to auto-match by bundle ID. |

## GitHub Actions example

```yaml
- name: Upload to tapflow
  run: |
    curl -X POST ${{ secrets.TAPFLOW_RELAY_URL }}/api/v1/builds \
      -H "Authorization: Bearer ${{ secrets.TAPFLOW_PAT }}" \
      -F "file=@MyApp.app.zip" \
      -F "status=In Progress"
```

## Build statuses

| Status | Meaning |
|--------|---------|
| Backlog | Not ready for testing |
| In Progress | Under active development |
| Done | QA passed |
| Rejected | Needs fixes |
