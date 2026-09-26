# Network Control

Pressing the network control button in the toolbar takes the simulator or emulator offline, and pressing it again brings it back online. Offline banners, retry handling and anything else that only appears with no connection can be checked from the browser.

The button works per simulator or emulator. Other devices running on the same agent Mac, and the agent Mac's own network, are unaffected.

**A request it cannot carry out is refused.** Telling the app it is offline without actually blocking its traffic would leave every request succeeding behind a screen that says otherwise, and offline behaviour checked in that state has not been checked at all. So tapflow applies all of it or none of it, and the button says why.

## What is cut, and what is not

Taking a device offline blocks every connection it **opens from then on**, except over the agent Mac's own loopback. Connections that were already open are cut as well, but only inside the app tapflow launched.

The network filter on the Mac judges new connections only — a connection it has already allowed cannot be taken back. So already-open sockets are cut from inside the app instead, which works only in the app tapflow launched. Anything else keeps using the connections it already has: the simulator's browser, or an app you did not launch through tapflow.

In practice it looks like this: a screen that was already downloading when you pressed the button carries on for a moment, while a screen opened at that same moment fails right away. Both are normal.

**Check with a new request.** Open a screen or pull to refresh so the app sends something new. Judging by watching a request that was already in flight finish makes it look as though offline did not take.

## Localhost is not cut

A dev server such as Metro reaches the device over the agent Mac's loopback, so it stays connected while the device is offline. You can watch offline behaviour with a debug build still attached.

## iOS needs the network extension

Network control on an iOS simulator requires the tapflow network extension to be installed once **on the agent Mac**. It installs on the Mac, not in the simulator: a simulator has no radio to switch off and shares the Mac's network.

The extension comes with tapflow. The install and approval steps are in [Troubleshooting](/guide/troubleshooting#network-not-set-up); both happen on the agent Mac, and approving it needs an administrator password.

## When the button says why

A device that cannot be taken off the network draws the button in the failure colour along with what to do about it.

| What the button says | What to do |
|---|---|
| Launch an app | Launch an app through tapflow. Traffic can already be cut; telling the app needs it running under tapflow |
| Restart the device | Restart the device. Nothing was set up for it on this boot |
| It could not be confirmed — try again | Press it again. This appears while a device is booting, or when the connection to it drops briefly |
| The device did not change when asked | Press it again. If it keeps happening, that device will not take the setting — use another one |
| tapflow cannot tell this app it is off the network | Pressing again gives the same answer. Try launching a different app, and check the `Network hook` lines of `tapflow doctor ios` on the agent Mac |
| This Mac is not set up for it | See [iOS needs the network extension](#ios-needs-the-network-extension) above. It is an install step on the agent Mac |

**Pressing again is only worth it where it says to try again.** The rest answer the same way however many times they are pressed.

If a notice tells you the device went back on the network on its own while you were checking, the offline behaviour you have checked so far needs checking again. [Troubleshooting](/guide/troubleshooting#network-stopped) covers the cause and what to do.

## What you are trusting

This extension is handed **every connection the simulator opens, before the traffic leaves the Mac**, and decides whether it goes through. It is the largest trust tapflow asks for, so here it is plainly.

- **What it sees** — that a connection attributed to a simulator exists, and where it is going. It does not read contents.
- **What leaves the Mac** — nothing. Every decision is made on the Mac, and the state file the extension writes is local.
- **Who signs it** — tapflow's Developer ID, notarized by Apple.

**What a signature proves, and what it does not.** These two commands confirm the app is tapflow's and has not been tampered with since:

```sh
codesign -dv --verbose=4 /Applications/TapflowNetFilter.app
spctl -a -vv /Applications/TapflowNetFilter.app
```

What they do **not** prove is that this binary was built from the Swift committed to the repository. The app is built on a maintainer's Mac and committed, and the signing key deliberately does not live in CI, because otherwise anyone who can push a tag could sign a network filter. The price of that choice is a build nobody can reproduce. To check the source-to-binary link yourself, read the sources and build it: that needs a paid Apple Developer account.

**Switching it off and removing it are different things.** System Settings → General → Login Items & Extensions → Network Extensions turns it off and leaves it installed. To remove it, first stop tapflow on this Mac (`tapflow start`, `tapflow agent start`) — a running iOS agent switches the filter back on. Then switch the filter off and delete the app:

```sh
/Applications/TapflowNetFilter.app/Contents/MacOS/TapflowNetFilter --off
rm -rf /Applications/TapflowNetFilter.app
```

Last, click the ⋯ button beside TapflowNetFilter on that same screen, choose **Delete Extension**, and restart the Mac. It stays in that list after the app is gone, so it can still be deleted there. The removal finishes at the restart; until then `systemextensionsctl list` shows it as `terminated waiting to uninstall on reboot`. The filter goes off first because deleting one that is on can block the Mac's new connections.

`systemextensionsctl uninstall` is not an option. macOS refuses it on any Mac with System Integrity Protection (SIP) on.

Deleting `/Applications/TapflowNetFilter.app` on its own does not remove it. macOS keeps running an extension whose container app is gone, and `tapflow doctor ios` reports that state separately.

::: warning A hybrid app's WebView draws no offline banner
Screens running inside a WebView are not reached by the offline notification, so no banner appears. This is a known limitation.

**Connections a WebView already had open are not cut either.** Cutting open sockets works only inside the app tapflow launched, and a WebView's networking runs in separate processes that it does not reach. Connections the WebView opens after that fail like any other request.

Confirm offline behaviour on those screens by a **new request** failing, rather than by a banner.
:::

::: tip Error codes differ from a real device
An iOS simulator reports `NSURLErrorNetworkConnectionLost` (`-1005`), not the `NSURLErrorNotConnectedToInternet` (`-1009`) a real device in airplane mode gives, so if your app branches on the error code, check that it handles both.
:::
