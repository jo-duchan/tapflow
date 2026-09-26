---
title: iOS network extension
description: Install and approve the network extension that iOS network control needs on the agent Mac, and recover when replacing it cuts the Mac off or a device comes back online by itself.
---

# iOS network extension

Install the network extension that iOS network control needs on the agent Mac, and recover when it stops working.

## iOS: the network extension is not installed {#network-not-set-up}

Network control on an iOS simulator needs the tapflow network extension installed on the agent Mac. **It comes with tapflow, so there is nothing to download.** One command installs the copy already in the package.

### 1. Install it

On a Mac you are setting up for the first time, the iOS setup covers the extension too.

```sh
tapflow setup ios
```

On a Mac that already ran setup, setup does not run again, so a machine configured before this feature existed needs its own command.

```sh
tapflow migrate net-filter
```

### 2. Approve it

Requesting the install brings up a macOS approval prompt. Choose **Open System Settings**. The highlighted **OK** only closes the prompt and approves nothing.

Go to **System Settings → General → Login Items & Extensions → Network Extensions** and switch the tapflow entry on. (An administrator password is required.)

Approval happens at the Mac. macOS offers no path a browser could click instead.

**The command can open the approval screen for you.** When this Mac has no approved tapflow extension, it asks before the install starts whether to open the screen when macOS asks. Say yes and the screen opens as soon as macOS starts waiting; switch TapflowNetFilter on there and the install finishes. macOS does not show its prompt again for an extension that is already waiting, so on a rerun this screen is the quickest way there.

It asks only when both its input and output are a terminal, so a pipe or a redirect stops it from asking even in one.

**Missing the first two minutes is not the end of it.** The install waits up to two minutes for approval. If the entry is not switched on by then, and the command can ask and you did not decline its offer, it waits up to two more minutes and switches the filter on once the entry is on. If it did not ask up front, because macOS was not expected to ask (replacing an approved extension, for instance), it asks at this point whether to open the screen.

Switching the filter on can briefly drop connections this Mac already has open, SSH sessions included — if you are connected over SSH, run it at the Mac. If macOS asks whether to allow tapflow to filter network content when it switches on, allow it.

If no screen appears, go there by the path above. The command cannot tell whether the window opened, so it shows the path alongside.

If you declined, or ran it where it cannot ask, the command ends still waiting for approval unless you approve it yourself within the first two minutes. A declined offer is not repeated. Not switching it on within the two extra minutes ends the same way. Approve it and run the same command once more. That run switches the filter on.

If a device came into use during the two extra minutes (a simulator booted, say), it stops without switching the filter on. It names what it found; stop that and run the command again. An approval within the first two minutes lets the extension switch the filter on by itself, so the only device check on that path is the one when the install starts.

### 3. When a restart is needed

Replacing an already-installed extension finishes only after the Mac restarts. **Until then the previous version keeps running** — the file on disk is the new one while macOS is still running the old one, so the dashboard goes on saying the Mac is not set up.

### Checking what the Mac has

```sh
tapflow doctor ios
```

It reports four things separately: whether it is **installed**, whether it is **approved**, whether it is **switched on**, and whether the versions on this Mac are the **ones this tapflow carries**. The last two are separate because the ones before them can all be right while the control still does not work — a replacement waiting for a restart is one such state, and a filter switched off is another. Switched off has no version of its own: the extension stays listed as activated, so every version reads correctly while nothing is being filtered.

**Two things carry a version**: the app in `/Applications` and the system extension inside it. They move independently, because a release that changes only the app has no reason to make macOS replace a running filter. The check names whichever is behind, and they need different things.

| What it says is behind | What to do |
|---|---|
| The app in `/Applications` | `tapflow migrate net-filter`. It copies the app; macOS skips the activation, so nothing is interrupted. The agent calls that binary, which is why a stale one matters |
| The extension, with a restart mentioned | Restart the Mac. The replacement is installed and finishes then |
| The extension, with no restart mentioned | `tapflow migrate net-filter` |
| This Mac is set up for a newer tapflow | Upgrade this checkout instead. Migrate refuses that direction, because replacing a newer filter breaks the agent depending on it |

**If the app is gone but the extension is still running, tapflow refuses to reinstall.** The extension's version says which filter is running, not which app it came from, so nothing can tell whether that Mac was set up by a newer tapflow than yours — and installing over it would replace a working filter someone else may depend on. Reinstall from the tapflow whose version matches, or clear the extension and start again. `tapflow doctor ios` and the command that refused both print the steps:

1. Switch the filter off. The app is gone, so this uses the binary inside the package, and the command prints its exact path.
2. Click the ⋯ button beside TapflowNetFilter and choose **Delete Extension**, in System Settings → General → Login Items & Extensions → Network Extensions. This works with the app already gone from `/Applications`.
3. Restart the Mac. The removal finishes then.

`systemextensionsctl uninstall` is not an option: macOS refuses it on any Mac with System Integrity Protection (SIP) on.

### If it still does not work

Installing ends with a distinct code per kind of failure.

| Code | Meaning |
|---|---|
| 1 | Activation failed |
| 2 | Could not read the configuration |
| 3 | Could not save the configuration |
| 4 | Not approved within 120 seconds. With input and output both on a terminal, the command keeps waiting, first asking whether to open the approval screen if it has not asked yet. If it is still not switched on after that, it could not ask, or the offer was declined, the command ends waiting for approval: approve it in System Settings and run it again |
| 5 | The Mac has to restart for this to finish |
| 6 | The system extension manager gave no answer within 45 seconds |
| 7 | The running filter did not answer |
| 8 | An argument this build does not understand. Can happen when the installed filter app is older than the agent |

What the extension can and cannot see is in [Network Control](/testing/network-control#what-you-are-trusting).

## Troubleshooting

### iOS: the Mac lost its network while the filter was being replaced {#network-lost-on-replace}

The filter decides on **every new connection the Mac makes**, not only the simulator's. When it stops
while it is still switched on, macOS does not let traffic through unchecked. It blocks all of it,
which is the safe choice for a filter and a sudden one for you. Replacing the extension stops the
filter for a moment, so the replacement is where this happens.

The failures are immediate rather than slow: **`No route to host`**, not a long wait. Connections
already open keep working, which is why some things carry on while a browser stops.

`tapflow migrate net-filter` switches the filter off twice on the way through: once before it copies
the new app in, and once before it activates. The second is a gate — rather than activate over a filter
it could not switch off, the command stops and tells you. The first is best effort, so on a Mac where
it does not take you are back to the narrow window this section describes rather than clear of it.

When the command does stop, it says whether the filter was left switched off. Your network works in
that state and only iOS network control is missing.

**Getting the network back does not need a restart.**

```sh
/Applications/TapflowNetFilter.app/Contents/MacOS/TapflowNetFilter --off
```

That takes the filter out of the path and traffic returns. iOS network control stays unavailable
until the filter is on again, which is what running the migration again does.

```sh
tapflow migrate net-filter
```

### iOS: a device that was offline came back on the network by itself {#network-stopped}

A notice saying the device went back on the network while you were checking means **the offline behaviour you have checked so far needs checking again.** Requests may have been succeeding between the moment traffic started passing and the moment the notice appeared.

What stopped is the filter on the agent Mac that was blocking the traffic — either the extension was switched off in System Settings, or the filter process died and macOS is bringing it back. Bringing it back takes about six seconds, and nothing is blocked for any of them.

**Check**

```sh
systemextensionsctl list
```

If `dev.tapflow.netfilter.ext` is not `[activated enabled]`, go back to [installing and approving it](#network-not-set-up).

If it is enabled and this keeps happening, the filter process is dying repeatedly.

```sh
log show --last 10m --predicate 'subsystem == "dev.tapflow.netfilter"' --info --debug --style compact
```

**What to do**

Take the device offline again and redo the check from the start. The button draws normally once the filter is back. If the same notice keeps appearing, offline checks on that Mac cannot be trusted until the cause is found, so use another agent Mac in the meantime.

Logs are at `/tmp/tapflow-netfilter-host.log`.

For the feature itself, see [Network Control](/testing/network-control).
