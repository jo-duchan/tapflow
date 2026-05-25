import { useState } from 'react'
import type { AgentDevice, SessionInfo } from '@/lib/types'

export function useDeviceSelector(
  selectedSession: SessionInfo | undefined,
  os: string,
) {
  const [osVersion, setOsVersion] = useState('')
  const [deviceSearch, setDeviceSearch] = useState('')
  const [resetMode, setResetMode] = useState<'app-only' | 'full-erase'>('app-only')

  const filteredDevices = selectedSession?.devices.filter((d) => d.platform === os) ?? []

  const osVersions = [
    ...new Set(filteredDevices.map((d) => d.osVersion).filter(Boolean)),
  ].sort((a, b) => {
    const parts = (s: string) => s.replace(/^[^\d]*/, '').split('.').map(Number)
    const [aParts, bParts] = [parts(a as string), parts(b as string)]
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const diff = (bParts[i] ?? 0) - (aParts[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  }) as string[]

  const versionedDevices = (osVersion
    ? filteredDevices.filter((d) => d.osVersion === osVersion)
    : filteredDevices
  ).filter((d) => !deviceSearch || d.name.toLowerCase().includes(deviceSearch.toLowerCase()))

  return {
    filteredDevices,
    osVersions,
    osVersion,
    setOsVersion,
    deviceSearch,
    setDeviceSearch,
    versionedDevices,
    resetMode,
    setResetMode,
  }
}
