# Expo build integration

tapflow works on the **built artifact**, not the framework. Expo apps are React Native apps too; this page covers the EAS build path. The iOS simulator build that Expo `eas build` produces comes out as a `.tar.gz`, and tapflow takes that format as-is — no repackaging or conversion.

```
Expo / EAS
  → eas build (iOS simulator → .tar.gz · Android → .apk)
  → CI POSTs /api/v1/builds (tapflow relay)
  → Build appears in App Center
  → Team picks a device in the browser and tests
```

tapflow does not replace EAS. EAS builds, signs, and ships your app; tapflow slots in right *after* the build so the whole team can see the result without installing anything. Your Metro (Fast Refresh) dev loop stays exactly as it is.

::: info Two testing paths
This guide covers the **manual review path**: CI delivers the build; people do the testing.

For automated testing where an LLM agent controls the simulator, see [MCP in CI/CD](/guide/mcp-ci). That is a separate, experimental feature.
:::

## 1. Add a profile to eas.json

Define one profile that produces a simulator build.

```json
{
  "build": {
    "tapflow": {
      "ios": { "simulator": true },
      "android": { "buildType": "apk" }
    }
  }
}
```

For iOS, `simulator: true` is the key part — it produces a build that runs on the Simulator (`.tar.gz`). The default device build is an `.ipa`, which does not run on the Simulator.

## 2. Produce the build

```sh
eas build --profile tapflow --platform all
```

iOS comes out as a `.tar.gz` (with the simulator `.app` inside), Android as an `.apk`. tapflow takes both formats as-is.

## 3. Upload to tapflow

When the build finishes, upload the artifact to the relay's `POST /api/v1/builds`. If you build in CI, use that file directly; if you use EAS cloud builds, download the artifact from the URL EAS returns on completion.

First, create a Personal Access Token with the `builds:write` scope. Token creation and how to pick the relay URL are covered in [Build Distribution](/guide/build-distribution) under token generation and "How CI reaches the relay".

```sh
curl -X POST "$TAPFLOW_RELAY_URL/api/v1/builds" \
  -H "Authorization: Bearer $TAPFLOW_PAT" \
  -F "file=@build.tar.gz" \
  -F "status=In Progress" \
  -F "label=$GIT_BRANCH"
```

The bundle ID, version, and build number are extracted automatically from the uploaded build, so there is nothing to type in.

To upload automatically when an EAS build finishes, add a small receiver that takes the EAS Webhook completion event, downloads the artifact URL, and makes the same request above. tapflow's job is to accept that standard multipart upload.

## 4. The team tests in the browser

The uploaded build appears in App Center. Anyone opens it in the browser, picks a device, and runs it — firing deep links, reviewing layout, and checking API wiring with no install.

::: warning Simulator limits
Because it runs on the Simulator, hardware-dependent features — camera, biometric auth, push tokens — cannot be verified here. Those still need real-device QA.
:::

The full upload contract — tokens, a GitHub Actions example, and build statuses — is in [Build Distribution](/guide/build-distribution).
