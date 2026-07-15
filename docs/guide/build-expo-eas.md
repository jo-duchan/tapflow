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

### Automating the upload with an EAS webhook

The curl above is a manual upload. To run it automatically when an EAS build finishes, point an [EAS webhook](https://docs.expo.dev/eas/webhooks/) at a small receiver you host. tapflow does not receive the EAS webhook directly; it only accepts the standard multipart upload. The receiver bridges the two: it verifies the event, downloads the artifact, and POSTs it to the relay.

```
EAS build finishes
  → EAS webhook       → your receiver: verify signature → download artifact
                      → POST /api/v1/builds (tapflow relay)
  → Build appears in App Center → team reviews
  → status → Done / Rejected  → tapflow webhook → Slack · next deploy step
```

A minimal receiver (Node):

```js
import express from 'express'
import crypto from 'crypto'

const app = express()
app.use(express.raw({ type: 'application/json' })) // EAS signs the raw body

app.post('/eas', async (req, res) => {
  // 1. Verify the expo-signature header (HMAC-SHA1 of the raw body)
  const expected = 'sha1=' + crypto.createHmac('sha1', process.env.EAS_WEBHOOK_SECRET).update(req.body).digest('hex')
  const got = Buffer.from(req.get('expo-signature') ?? '')
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, Buffer.from(expected))) {
    return res.status(401).end()
  }

  const build = JSON.parse(req.body.toString())
  if (build.status !== 'finished') return res.status(200).end() // ignore errored / canceled

  // 2. Download the artifact (iOS .tar.gz / Android .apk)
  const artifact = await fetch(build.artifacts.applicationArchiveUrl).then((r) => r.arrayBuffer())
  const name = build.platform === 'ios' ? 'build.tar.gz' : 'build.apk'

  // 3. Hand it to tapflow — the same multipart upload as the curl above
  const form = new FormData()
  form.append('file', new Blob([artifact]), name)
  form.append('status', 'In Progress')
  const up = await fetch(`${process.env.TAPFLOW_RELAY_URL}/api/v1/builds`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TAPFLOW_PAT}` },
    body: form,
  })
  res.status(up.ok ? 200 : 502).end()
})

app.listen(3000)
```

Set the same secret on both sides: pass it to `eas webhook:create --event BUILD` and read it from `EAS_WEBHOOK_SECRET` in the receiver. Mind the direction — EAS signs with **HMAC-SHA1** (`expo-signature`), whereas tapflow's own outbound webhooks use HMAC-SHA256 (see [Webhooks](/guide/build-status-webhooks)).

If you'd rather not host a service, an EAS webhook can instead trigger a GitHub Actions run via `repository_dispatch`, and the workflow does the download-and-POST — the same three steps, with no always-on receiver.

## 4. The team tests in the browser

The uploaded build appears in App Center. Anyone opens it in the browser, picks a device, and runs it — firing deep links, reviewing layout, and checking API wiring with no install.

::: warning Simulator limits
Because it runs on the Simulator, hardware-dependent features — camera, biometric auth, push tokens — cannot be verified here. Those still need real-device QA.
:::

The full upload contract — tokens, a GitHub Actions example, and build statuses — is in [Build Distribution](/guide/build-distribution).
