import type { DeviceSummary } from '@/lib/types'

/** A titled run of device cards in the picker (#1085). `title` is null when the list is one group, where a heading
 *  would only repeat what the filter already says. */
export interface DeviceGroup {
  key: string
  title: string | null
  devices: DeviceSummary[]
}

/** The name a person sees: an Admin's name for the device if it has one, else its own. */
export const shownName = (d: DeviceSummary): string => d.displayName ?? d.name

/** Newest first, by the numbers in the version (`iOS 26.5`, `Android 14`, `API 36`). */
export function compareVersions(a: string, b: string): number {
  const parts = (s: string) => s.replace(/^[^\d]*/, '').split('.').map(Number)
  const [aParts, bParts] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const diff = (bParts[i] ?? 0) - (aParts[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Splits the picker's devices into what is shown under each heading: the asker's favourites first, then one group per
 * OS version, newest first, and the devices with no version last. Hidden devices are left out unless `showHidden`
 * (only an Admin is offered it). Search matches the name shown and the device's own, so a renamed device is still
 * found by the name automation uses.
 */
export function groupDevices(devices: DeviceSummary[], opts: { osVersion: string; search: string; showHidden: boolean }): DeviceGroup[] {
  const q = opts.search.trim().toLowerCase()
  const shown = devices.filter((d) =>
    (opts.showHidden || !d.hidden) &&
    (!opts.osVersion || d.osVersion === opts.osVersion) &&
    (!q || shownName(d).toLowerCase().includes(q) || d.name.toLowerCase().includes(q)))

  const groups: DeviceGroup[] = []
  const favourites = shown.filter((d) => d.favourite)
  if (favourites.length > 0) groups.push({ key: 'favourites', title: 'Favourites', devices: favourites })
  const rest = shown.filter((d) => !d.favourite)
  const versions = [...new Set(rest.flatMap((d) => (d.osVersion ? [d.osVersion] : [])))].sort(compareVersions)
  for (const v of versions) groups.push({ key: `v:${v}`, title: v, devices: rest.filter((d) => d.osVersion === v) })
  const unversioned = rest.filter((d) => !d.osVersion)
  if (unversioned.length > 0) groups.push({ key: 'other', title: 'Other', devices: unversioned })

  return groups.length === 1 ? [{ ...groups[0]!, title: null }] : groups
}
