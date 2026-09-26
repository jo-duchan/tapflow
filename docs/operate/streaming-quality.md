# Streaming Quality

tapflow streams each device screen as H.264 and decodes it in the browser. The resolution and decoder aren't fixed — tapflow picks one of three **profiles** per viewer, based on how that viewer connects, balancing image sharpness against decode cost for the path.

You don't select a profile. It follows from your relay deployment and the viewer's network, so the same device can serve a localhost-grade stream to one teammate and a bandwidth-trimmed stream to another on the road.

## Profiles

| Profile | Connection | Resolution | Decoder | Experience |
|---------|------------|------------|---------|------------|
| **Standard** *(recommended)* | LAN over HTTP | 1280 px | WASM (tinyh264) | Near-localhost responsiveness |
| **Smooth** | LAN over HTTPS *(or localhost)* | Native | WebCodecs (hardware) | Localhost-grade |
| **Remote** | External address | 1000 px | WebCodecs (hardware); WASM over plain HTTP | Usable QA threshold |

**Standard** is what most teams use day to day — a plain-HTTP relay on the LAN. The browser decodes H.264 with the software WASM decoder, so tapflow caps the resolution at 1280 px to keep decode load low while keeping responsiveness close to localhost.

**Smooth** is the best tapflow can offer. On a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) — HTTPS on the LAN, or localhost — the browser unlocks WebCodecs and decodes in hardware, so the agent sends native resolution at minimal CPU cost.

**Remote** covers viewers the relay sees arriving from a non-private address, such as a public IP. The link is assumed to be bandwidth-constrained, so the resolution is trimmed to 1000 px. HTTPS keeps hardware decoding; plain HTTP uses the WASM decoder. Enough for QA, at the edge of comfortable.

## How your deployment maps to a profile

The profile is decided by how the browser reaches the relay — which is exactly what you choose when you [self-host the relay](/guide/self-hosting).

| Your setup | Profile |
|------------|---------|
| Relay on the LAN over plain HTTP | **Standard** |
| Relay on the LAN over HTTPS | **Smooth** |
| HTTPS through a tunnel (VPS + rathole, `tailscale serve`) | **Smooth** |
| Direct connection to the relay port from a public IP or a tailnet address (`100.x`) | **Remote** |

A tunnel client connects over loopback from inside the relay Mac, so the relay cannot tell a viewer arriving through the tunnel from a local one. Viewers on an HTTPS tunnel therefore get native resolution. Tailscale's tailnet addresses, on the other hand, are not in the private-range list and count as external: opening the default plain-HTTP Tailscale URL gives a 1000 px stream decoded by the WASM decoder. If tunnel viewers are short on bandwidth, set a cap yourself with `TAPFLOW_MAX_SIZE` below.

To move a shared LAN from **Standard** to **Smooth**, serve the relay over HTTPS — see [External access](/guide/self-hosting#external-access) in Self-Hosting the Relay.

::: tip Why HTTPS unlocks hardware decoding
WebCodecs is only available in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts). Plain HTTP on the LAN is not secure, so the browser falls back to the WASM decoder — which is why **Standard** caps resolution and **Smooth** (HTTPS) doesn't.
:::

## Tuning the resolution

The profile is automatic, but you can override the resolution caps. Set these on the Mac running the agent.

| Variable | Default | Description |
|----------|---------|-------------|
| `TAPFLOW_MAX_SIZE` | *(per profile)* | Cap for all platforms (px, longest side). `0` forces native resolution on every connection. |
| `TAPFLOW_MAX_SIZE_LAN` | `1280` | Standard (LAN HTTP) cap. |
| `TAPFLOW_MAX_SIZE_EXTERNAL` | `1000` | Remote (external) cap. |
| `TAPFLOW_IOS_MAX_SIZE` | *(per profile)* | iOS-specific override. Takes precedence over `TAPFLOW_MAX_SIZE`. |
| `TAPFLOW_ANDROID_MAX_SIZE` | *(per profile)* | Android-specific override. Takes precedence over `TAPFLOW_MAX_SIZE`. |
| `TAPFLOW_ANDROID_FPS` | `30` | Frame-rate cap for the Android stream. |

Stream quality also depends on a stable, low-latency link between the agent and the relay. For agent placement and network requirements, see [Agent Setup](/operate/agents).
