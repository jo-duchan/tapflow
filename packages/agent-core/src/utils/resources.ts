import os from 'os'
import { spawnSync } from 'child_process'

export function createResourceSampler() {
  let lastCpuTimes: { idle: number; total: number } | null = null

  function getCpuPercent(): number {
    let idle = 0, total = 0
    for (const cpu of os.cpus()) {
      const t = cpu.times
      idle += t.idle
      total += t.user + t.nice + t.sys + t.idle + t.irq
    }
    if (!lastCpuTimes) {
      lastCpuTimes = { idle, total }
      return 0
    }
    const idleDiff = idle - lastCpuTimes.idle
    const totalDiff = total - lastCpuTimes.total
    lastCpuTimes = { idle, total }
    if (totalDiff === 0) return 0
    return Math.min(100, Math.round((1 - idleDiff / totalDiff) * 1000) / 10)
  }

  // macOS: active + wired + compressed pages only. Falls back to os.freemem() on other OS.
  function getMemoryUsage(): { memUsedMB: number; memTotalMB: number } {
    const memTotalMB = Math.round(os.totalmem() / 1024 / 1024)
    try {
      const { stdout, status } = spawnSync('vm_stat', [], { encoding: 'utf8' })
      if (status !== 0 || !stdout) throw new Error('vm_stat failed')
      const lines = (stdout as string).split('\n')
      const pageSize = parseInt(lines[0]?.match(/page size of (\d+)/)?.[1] ?? '16384')
      const get = (key: string) => {
        const m = lines.find((l) => l.startsWith(key))?.match(/:\s*(\d+)/)
        return parseInt(m?.[1] ?? '0')
      }
      const pages = get('Pages active') + get('Pages wired down') + get('Pages occupied by compressor')
      return { memUsedMB: Math.round(pages * pageSize / 1024 / 1024), memTotalMB }
    } catch {
      return { memUsedMB: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024), memTotalMB }
    }
  }

  return { getCpuPercent, getMemoryUsage }
}
