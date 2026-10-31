import { useCallback, useState } from 'react'
import type { SessionInfo } from '@/lib/types'
import { compareVersions, groupDevices } from '@/lib/deviceGroups'

export function useDeviceSelector(
  selectedSession: SessionInfo | undefined,
  os: string,
  isAdmin = false,
) {
  const [osVersion, setOsVersion] = useState('')
  // Hidden devices are for an Admin to bring back, so only an Admin is offered them (#1085).
  const [showHiddenChosen, setShowHidden] = useState(false)
  const showHidden = isAdmin && showHiddenChosen
  const [deviceSearch, setDeviceSearch] = useState('')
  const [resetMode, setResetMode] = useState<'app-only' | 'full-erase'>('app-only')
  // What the device currently on screen was actually booted with. Held apart from `resetMode`
  // because picking a device disarms the toggle immediately, and the viewer still has to know
  // which mode it was launched under.
  const [appliedResetMode, setAppliedResetMode] = useState<'app-only' | 'full-erase'>('app-only')

  /** Whether the agent holding this device honours `resetMode: 'full-erase'`.
   *
   *  This was `os !== 'android'`, which says "Android cannot" when what it means is "this agent did
   *  not say it can" — and the two differ in both directions (#447). An iOS agent too old to
   *  implement Full reset still reports `platform: 'ios'`, so the platform check offered a control
   *  that agent has no code for; and `AndroidAgent` implements `-wipe-data` now, which the platform
   *  check would still be hiding. That second half landed without touching this file, which is the
   *  argument for gating this way rather than a prediction about it.
   *
   *  No session picked yet means nothing known yet, so the control stays hidden. */
  const fullResetSupported = selectedSession?.capabilities.includes('full-reset') ?? false

  /** Full reset is a one-shot intent — "erase the next device I pick" — not a setting that stays
   *  on. Leaving a session is a conditional re-render, not an unmount, so without this the toggle
   *  survives back-to-the-list and silently erases the *next* device too (#439). */
  const consumeResetMode = useCallback(() => {
    // Applying a mode the agent does not honour would disarm the toggle having erased nothing,
    // which reads as "done"; the UI hides the switch for the same reason, and this keeps the two
    // from drifting apart.
    setAppliedResetMode(fullResetSupported ? resetMode : 'app-only')
    setResetMode('app-only')
  }, [resetMode, fullResetSupported])

  const filteredDevices = selectedSession?.devices.filter((d) => d.platform === os) ?? []

  const osVersions = [
    ...new Set(filteredDevices.flatMap((d) => (d.osVersion && (showHidden || !d.hidden) ? [d.osVersion] : []))),
  ].sort(compareVersions)
  const hiddenCount = filteredDevices.filter((d) => d.hidden).length

  // A version whose last device was just hidden is no longer offered; the filter falls back to every version rather
  // than naming one the Select has no item for.
  const shownVersion = osVersions.includes(osVersion) ? osVersion : ''
  const deviceGroups = groupDevices(filteredDevices, { osVersion: shownVersion, search: deviceSearch, showHidden })
  const versionedDevices = deviceGroups.flatMap((g) => g.devices)

  return {
    filteredDevices,
    osVersions,
    osVersion: shownVersion,
    setOsVersion,
    deviceSearch,
    setDeviceSearch,
    versionedDevices,
    deviceGroups,
    hiddenCount,
    showHidden,
    setShowHidden,
    resetMode,
    setResetMode,
    appliedResetMode,
    consumeResetMode,
    fullResetSupported,
  }
}
