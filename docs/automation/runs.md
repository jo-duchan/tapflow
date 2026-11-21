---
title: Flow Runs
description: "See tapflow flow run's records on the dashboard's Flow Runs page: CI and local runs apart, each flow's result, the screen it failed on or ended on and a video of the whole flow, and a link to watch the device while a run is in progress."
---

# Flow Runs

::: warning Experimental
The flow runner and its run records belong to **Automation**, one of the three ways to use tapflow, and are experimental. The most mature part of tapflow is the manual QA dashboard.
:::

The dashboard's **Flow Runs** page shows the records `tapflow flow run` leaves. When CI runs your flows on every build, anyone on the team can see in a browser which flow failed on which build, and why. A failure in the app is kept apart from an environment problem such as the device, the agent or the relay.

A run is recorded when the runner has a token. See [Recording runs](#recording) to set it up.

## How to use {#how-to-use}

1. Open **Flow Runs** in the dashboard's sidebar. It is listed there once the first run is recorded, and opens on CI runs.
2. Pick where the runs came from with **All** / **CI** / **Local** at the top. You can narrow the list by status (**Any status**, **Running**, **Passed**, **Failed**, **Cancelled**) and by flow name; part of a name is enough.
3. Select a row to open that run. Cmd-click (Ctrl-click on Windows and Linux) opens it in a new tab.

The list shows 25 runs a page, newest first; **Newer** and **Older** below it move between pages.

The filters are part of the address, so a filtered list is a link you can share.

### A run's page {#run-detail}

A run's page lists its flows in the order they ran.

- A failed flow shows its failure message, each step's result and a screenshot from the moment it failed. A passed flow shows the screen it ended on, as the evidence that it passed: a login flow shows the screen it logged in to. Select a screenshot to open it full size. A flow whose screenshot was not kept says why in its place: it was over the relay's 5 MB limit, what the device sent was not an image, the relay's disk was full, or the device did not return one in time.
- A `tapOn` step that failed because it found no element, or several, lists lines to try instead under **Try instead**, from the screen at the moment it failed. Each line has a **Copy** button. [Flows](/automation/flows#selectors) explains how they are chosen.
- A flow the run never reached is marked **Not run**.
- A flow the runner chose not to run is marked **Skipped: another app** (a flow for a different app than the build) or **Skipped: tags** (left out by the tag options), with the reason beside it. The list shows how many were skipped next to the passed count. See [Choosing flows](/automation/flows#choosing-flows).
- **Open the CI run** opens the run on the CI side when the CI recorded a link to it. For a run with a build, **Other runs of this build** lists the same build's other runs.

### Watch a flow's video {#flow-video}

A flow the runner kept a video of has a **Play the video** button. It downloads the whole flow, start to end, and plays it in the same device frame the live view draws. The screenshot shows the screen a flow ended on; the video shows how it got there. Nothing is downloaded until you select the button.

- The dots above the bar mark where each step started, red where one failed. A grey bar is a stretch that never reached the relay. Hover over a dot or bar to see what it is, and select it to go there.
- Dragging the bar catches on each step's start. Playback speed goes from 0.5× to 4×.
- The taps, swipes, pinches and long presses the runner sent are drawn over the video in blue, and drawn again when you go back to them. Only videos recorded by a runner from this release have them.
- A flow with no video says why: the agent sent JPEG, the device's stream had no frame a video could start from, or the video is past its retention window.
- A video that ends early says why too: it reached the 100 MB limit for one flow, video storage was full, the run was cancelled, the runner disconnected, or the end of the video never reached the relay.

### Watch a run in progress {#watch-a-run}

While a run is in progress, the list and the run's page refresh every few seconds. **Watch the device** on the run's page shows the device the runner is driving, live and read-only: nothing you click reaches the device. Up to 4 people can watch a session.

A run across several devices (`--parallel`) lists them at the top of its page, each with its reset, the flow it is running now and a **Watch** link for that device. A running flow says which device it is on after **Running on**, and the list shows how many devices the run used.

## What the statuses mean {#statuses}

| Status | Meaning |
|--------|---------|
| **Running** | In progress |
| **Passed** | Every flow passed |
| **Failed** | At least one flow failed on the app |
| **Environment problem** | Every failure was the environment (the device, the agent or the relay), not the app. A run that failed before any flow started is shown here too, and its page gives the reason. Shown in gray rather than red so a regression stands out. The Status filter counts it under **Failed**. |
| **Cancelled** | The run was cancelled (Ctrl+C, a cancelled CI job). A run whose runner disconnected before saying it was over is shown here too, and its page says so. |

## Recording runs (operator) {#recording}

- Give `tapflow flow run` an API-type token (`view, builds:write`) and every run is recorded. Pass it with `--token` or `TAPFLOW_TOKEN`, or keep it in the [token file](/automation/mcp-server#token-file). The details are in the [Flow reference's run records](/automation/flows#run-records).
- Add `--no-record` to skip recording.
- Video retention is set in the **Flow run videos** card of **Settings → Default** (Admin): how many days passed flows' videos are kept and how much storage videos may use, with what is in use now. The defaults are 3 days and 20 GB. A failed flow's video is kept as long as its run unless storage runs out: when storage is full the oldest passed videos go first, and failed ones only after every passed one has gone.
- When you run it locally, the runner prints a link to the run's page when it ends. In CI it prints the run's id only, so the relay's address stays out of the log.
- A run's record is deleted with its build; a record of a run with no build is deleted after 7 days.

## Related {#related}

- [Flow reference](/automation/flows): writing flows and the `tapflow flow run` options
- [MCP in CI/CD](/automation/mcp-ci): running flows in CI
- [Runs in the REST API](/reference/api#runs): the endpoints that write and read run records
