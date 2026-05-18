import { describe, it, expect, vi, afterEach } from 'vitest'
import os from 'os'

// vi.hoisted로 mock 함수를 먼저 만들고, vi.mock에서 참조한다.
// resources.ts가 `import { spawnSync } from 'child_process'`로 named import하므로
// vi.spyOn 대신 모듈 전체를 교체해야 spy가 동작한다.
const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }))
vi.mock('child_process', () => ({ spawnSync: spawnSyncMock }))

import { createResourceSampler } from '../utils/resources'

describe('createResourceSampler', () => {
  afterEach(() => vi.restoreAllMocks())

  describe('getCpuPercent', () => {
    it('첫 호출은 0을 반환한다 (baseline 수집 단계)', () => {
      const { getCpuPercent } = createResourceSampler()
      expect(getCpuPercent()).toBe(0)
    })

    it('두 번째 호출에서 실제 CPU% 계산값을 반환한다', () => {
      // baseline: user=100, sys=100, idle=800 → total=1000
      vi.spyOn(os, 'cpus').mockReturnValue([
        { times: { user: 100, nice: 0, sys: 100, idle: 800, irq: 0 } },
      ] as ReturnType<typeof os.cpus>)

      const { getCpuPercent } = createResourceSampler()
      getCpuPercent() // baseline

      // second: idle+100(→900), total+200(→1200) → cpu% = (1 - 100/200) × 100 = 50%
      vi.spyOn(os, 'cpus').mockReturnValue([
        { times: { user: 150, nice: 0, sys: 150, idle: 900, irq: 0 } },
      ] as ReturnType<typeof os.cpus>)

      expect(getCpuPercent()).toBe(50)
    })

    it('total diff가 0이면 0을 반환한다 (NaN 방지)', () => {
      vi.spyOn(os, 'cpus').mockReturnValue([
        { times: { user: 100, nice: 0, sys: 0, idle: 900, irq: 0 } },
      ] as ReturnType<typeof os.cpus>)

      const { getCpuPercent } = createResourceSampler()
      getCpuPercent() // baseline

      // 동일한 값 → totalDiff=0
      expect(getCpuPercent()).toBe(0)
    })

    it('100%를 초과하지 않는다 (clamp)', () => {
      vi.spyOn(os, 'cpus').mockReturnValue([
        { times: { user: 0, nice: 0, sys: 0, idle: 1000, irq: 0 } },
      ] as ReturnType<typeof os.cpus>)

      const { getCpuPercent } = createResourceSampler()
      getCpuPercent() // baseline

      // idle이 줄고 total이 늘어 가상의 100% 초과 상황
      vi.spyOn(os, 'cpus').mockReturnValue([
        { times: { user: 2000, nice: 0, sys: 0, idle: 500, irq: 0 } },
      ] as ReturnType<typeof os.cpus>)

      expect(getCpuPercent()).toBeLessThanOrEqual(100)
    })

    it('복수 CPU 코어 값을 합산한다', () => {
      // baseline per core: user=100, idle=900 → total=1000 / 2 cores → 1800/2000
      vi.spyOn(os, 'cpus').mockReturnValue([
        { times: { user: 100, nice: 0, sys: 0, idle: 900, irq: 0 } },
        { times: { user: 100, nice: 0, sys: 0, idle: 900, irq: 0 } },
      ] as ReturnType<typeof os.cpus>)

      const { getCpuPercent } = createResourceSampler()
      getCpuPercent() // baseline: idle=1800, total=2000

      // second per core: user=200, idle=1000 → total=1200 / 2 cores → 2000/2400
      // idleDiff=200, totalDiff=400 → cpu% = (1 - 200/400) × 100 = 50%
      vi.spyOn(os, 'cpus').mockReturnValue([
        { times: { user: 200, nice: 0, sys: 0, idle: 1000, irq: 0 } },
        { times: { user: 200, nice: 0, sys: 0, idle: 1000, irq: 0 } },
      ] as ReturnType<typeof os.cpus>)

      expect(getCpuPercent()).toBe(50)
    })
  })

  describe('getMemoryUsage', () => {
    it('vm_stat 파싱 성공 시 active+wired+compressed 기반 memUsedMB 반환', () => {
      vi.spyOn(os, 'totalmem').mockReturnValue(16 * 1024 * 1024 * 1024)
      spawnSyncMock.mockReturnValue({
        stdout: [
          'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
          'Pages active:           100.',
          'Pages wired down:        50.',
          'Pages occupied by compressor:  25.',
          'Pages free:             1000.',
        ].join('\n'),
        status: 0,
      })

      const { getMemoryUsage } = createResourceSampler()
      const { memUsedMB, memTotalMB } = getMemoryUsage()

      // (100 + 50 + 25) × 16384 = 2,867,200 bytes → 2 MB (rounded)
      expect(memUsedMB).toBe(Math.round(175 * 16384 / 1024 / 1024))
      expect(memTotalMB).toBe(16 * 1024)
    })

    it('vm_stat 실패(status≠0) 시 os.freemem() 기반 fallback 사용', () => {
      vi.spyOn(os, 'totalmem').mockReturnValue(8 * 1024 * 1024 * 1024)
      vi.spyOn(os, 'freemem').mockReturnValue(2 * 1024 * 1024 * 1024)
      spawnSyncMock.mockReturnValue({ stdout: '', status: 1 })

      const { getMemoryUsage } = createResourceSampler()
      const { memUsedMB, memTotalMB } = getMemoryUsage()

      expect(memUsedMB).toBe(6 * 1024) // 8GB - 2GB = 6 GB = 6144 MB
      expect(memTotalMB).toBe(8 * 1024)
    })

    it('vm_stat stdout이 비어있어도 fallback 사용', () => {
      vi.spyOn(os, 'totalmem').mockReturnValue(4 * 1024 * 1024 * 1024)
      vi.spyOn(os, 'freemem').mockReturnValue(1 * 1024 * 1024 * 1024)
      spawnSyncMock.mockReturnValue({ stdout: '', status: 0 })

      const { getMemoryUsage } = createResourceSampler()
      const { memUsedMB } = getMemoryUsage()
      expect(memUsedMB).toBe(3 * 1024) // 4GB - 1GB = 3 GB = 3072 MB
    })
  })
})
