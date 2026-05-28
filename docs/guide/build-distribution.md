# Build Distribution

Connect your CI pipeline so every build lands in App Center automatically — no manual uploads.

## How it works

```
CI pipeline
  → POST /api/v1/builds (tapflow relay)
  → Build appears in App Center
  → Team opens browser, picks a device, and tests
      PO / PM: does it match the spec?
      Designer: does it match the design?
      Backend: is the API wired up correctly?
      QA: any bugs to report?
```

The CI job uploads the build artifact. From there, anyone on the team can test directly in the browser — no IDE, no device setup needed.

::: info Two testing paths
This guide covers the **manual review path**: CI delivers the build; people do the testing.

For automated testing where an LLM agent controls the simulator, see [MCP in CI/CD](/guide/mcp-ci). That is a separate, experimental feature.
:::

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| tapflow relay | Running and reachable from your CI environment |
| Personal Access Token | Create one in **Settings → Tokens** with `builds:write` scope |

## 1. Generate a token

In the dashboard, go to **Settings → Tokens → New Token**.

- **Name**: something descriptive, e.g. `GitHub Actions`
- **Scope**: `builds:write`
- **Expiry**: optional

Copy the token — it is shown only once. Store it as a CI secret (e.g. `TAPFLOW_PAT`).

## 2. Upload the build

Call `POST /api/v1/builds` after the build artifact is ready.

```sh
# iOS (.app.zip)
curl -X POST https://your-relay/api/v1/builds \
  -H "Authorization: Bearer $TAPFLOW_PAT" \
  -F "file=@MyApp.app.zip" \
  -F "status=In Progress" \
  -F "label=$GIT_BRANCH"

# Android (.apk)
curl -X POST https://your-relay/api/v1/builds \
  -H "Authorization: Bearer $TAPFLOW_PAT" \
  -F "file=@MyApp.apk" \
  -F "status=In Progress" \
  -F "label=$GIT_BRANCH"
```

`status=In Progress` signals to the team that the build is ready for review.  
Use `label` to attach context — branch name, ticket number, or a short description.

::: warning iOS builds
`.ipa` files are not supported. Use `.app.zip` only.  
Build with `xcodebuild -sdk iphonesimulator`, then zip the `.app` folder.
:::

## 3. Post build metadata (optional)

Attach commit and branch info as a comment so reviewers know what changed.

```sh
BUILD_ID=$(curl -sf -X POST https://your-relay/api/v1/builds \
  -H "Authorization: Bearer $TAPFLOW_PAT" \
  -F "file=@MyApp.app.zip" \
  -F "status=In Progress" \
  -F "label=$GIT_BRANCH" | jq -r '.id')

curl -X POST https://your-relay/api/v1/comments \
  -H "Authorization: Bearer $TAPFLOW_PAT" \
  -F "build_id=$BUILD_ID" \
  -F "body=Branch: $GIT_BRANCH
Commit: $GIT_SHA
$GIT_COMMIT_MSG"
```

## GitHub Actions example

```yaml
name: Upload to tapflow

on:
  push:
    branches: [main, 'release/**']
  pull_request:

jobs:
  upload:
    runs-on: macos-latest

    steps:
      - uses: actions/checkout@v4

      - name: Build app
        run: |
          xcodebuild -scheme MyApp -sdk iphonesimulator \
            -configuration Debug \
            CONFIGURATION_BUILD_DIR=build/Debug
          cd build/Debug && zip -r MyApp.app.zip MyApp.app

      - name: Upload to tapflow
        env:
          TAPFLOW_PAT: ${{ secrets.TAPFLOW_PAT }}
          TAPFLOW_RELAY_URL: ${{ secrets.TAPFLOW_RELAY_URL }}
          BRANCH: ${{ github.head_ref || github.ref_name }}
          COMMIT: ${{ github.sha }}
          COMMIT_MSG: ${{ github.event.head_commit.message || github.event.pull_request.title }}
        run: |
          BUILD_RESPONSE=$(curl -sf -X POST "$TAPFLOW_RELAY_URL/api/v1/builds" \
            -H "Authorization: Bearer $TAPFLOW_PAT" \
            -F "file=@build/Debug/MyApp.app.zip" \
            -F "status=In Progress" \
            -F "label=$BRANCH")

          BUILD_ID=$(echo "$BUILD_RESPONSE" | jq -r '.id')

          COMMENT="Branch: $BRANCH"$'\n'"Commit: $COMMIT"$'\n'"$COMMIT_MSG"

          curl -sf -X POST "$TAPFLOW_RELAY_URL/api/v1/comments" \
            -H "Authorization: Bearer $TAPFLOW_PAT" \
            -F "build_id=$BUILD_ID" \
            -F "body=$COMMENT"
```

## Build status reference

| Status | Meaning |
|--------|---------|
| `Backlog` | Uploaded but not yet ready for review |
| `In Progress` | Ready — team can start testing |
| `Done` | Stakeholders approved |
| `Rejected` | Issues found, needs fixes |

CI sets `In Progress` on upload. `Done` and `Rejected` are set manually after review.
