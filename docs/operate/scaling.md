# Scaling Mac Resources

tapflow scales horizontally — add more Mac hosts to the same relay to expand your device pool. Each Mac runs its own agent and connects outbound to the relay, so no firewall changes are required.

::: warning Every agent Mac must share the relay's LAN
Each Mac you add streams to the relay continuously, so it must be on the same LAN as the relay. See [deployment networking](/operate/deployment#deployment-scenarios) for the requirements.
:::

See [Introduction — How it works](/get-started/introduction#how-it-works) for a diagram.

## Adding a second Mac

::: tip The relay must be reachable from all Macs
When running `tapflow agent start` on another Mac, `ws://localhost:4000` resolves to that Mac's own localhost — not the relay machine. Use the relay's local IP address (`ws://192.168.x.x:4000`).
:::

On the new Mac, install tapflow and point it at your existing relay. The relay runs on a different machine, so an `agent`-scope token is required ([Remote relay authentication](/operate/agents#remote-relay-authentication)):

```sh
npm install -g tapflow
tapflow agent start --relay ws://192.168.x.x:4000 --token tflw_pat_xxxxxxxx
```

That's it. The new Mac registers itself and its devices become visible in the dashboard immediately.

## Agent names

Each agent uses the Mac's hostname as its display name in the dashboard. To see which agent is which:

```sh
tapflow status
```

```
  ● agent  ◉ in use  ○ idle

  ● mac-mini-office.local  (iOS)
      ○  iPhone 16 Pro
      ○  iPhone 15

  ● mac-mini-lab.local  (iOS)
      ○  iPhone 14

  ● mac-mini-lab.local  (Android)
      ○  tapflow-phone

  3 agent(s) · 4 device(s) · 0 active session(s)
```

The agent name is Node's `os.hostname()`, which on macOS is usually the local hostname ending in `.local`. When one Mac runs both an iOS and an Android agent, the name appears twice, told apart by the `(iOS)` or `(Android)` after it. To change it, edit **Local hostname** under **System Settings → General → Sharing**.

## Simulators per Mac

iOS Simulator and Android Emulator are memory-intensive. Each Mac can typically run 2–4 simultaneously depending on available RAM.

Simulators are booted and managed through the dashboard. The agent reports every available device to the relay, booted or not, and boots one on demand when a teammate starts a session.

## Monitoring

Track CPU and RAM usage per agent from the **Mac Resources** tab in the dashboard.
Select a host to see its CPU and RAM, each as a time-series chart (1h / 6h / 24h / 7d).

For a quick CLI check:

```sh
tapflow status
```

## Mac Resources

**Route**: `/mac-resources`

CPU and RAM usage for each Mac agent. Useful for spotting overloaded hosts before assigning more sessions.

| Element | Description |
|---|---|
| Mac list | Macs that are connected now or have reported usage in the last 30 days, by hostname. A green dot marks a Mac whose agent is connected; select a Mac to show its charts. |
| Time-series chart | Historical CPU % (blue) and RAM % (purple). |
| Range selector | **1h** / **6h** / **24h** / **7d** — switches the visible window. |

Data is sampled once per minute and retained for 30 days.
