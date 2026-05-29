import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getResourceHealth } from '@/lib/resource-health'

// ResourceBar를 직접 inline으로 정의 — QASession.tsx와 동일한 로직
function ResourceBar({ label, percent, colorClass }: { label: string; percent: number; colorClass: string }) {
  return (
    <div>
      <span>{label}</span>
      <span>{percent.toFixed(0)}%</span>
      <div
        data-testid="bar-fill"
        className={colorClass}
        style={{ width: `${Math.min(100, percent)}%` }}
      />
    </div>
  )
}

// Mac 카드 — QASession.tsx Mac 그리드 항목과 동일한 렌더링 로직
interface SessionInfo {
  agentName?: string
  resources?: {
    cpuPercent: number
    memUsedMB: number
    memTotalMB: number
    slotsAvailable: number
    slotsTotal: number
    reportedAt: number
  }
  devices: { platform: string }[]
}

function MacCard({ session, onClick }: { session: SessionInfo; onClick?: () => void }) {
  const res = session.resources
  const isStale = res ? Date.now() - res.reportedAt > 30_000 : false
  const cpuPercent = res?.cpuPercent ?? 0
  const memPercent = res ? (res.memUsedMB / res.memTotalMB) * 100 : 0
  const deviceCount = session.devices.length
  const health = getResourceHealth(res, isStale)
  const isOverloaded = health === 'overloaded'

  return (
    <button
      data-testid="mac-card"
      disabled={isOverloaded}
      onClick={onClick}
      title={isOverloaded ? 'This Mac is currently overloaded. Try again later.' : undefined}
    >
      <span data-testid="health-dot" data-health={health} />
      <span data-testid="agent-name">{session.agentName ?? 'Unknown'}</span>
      {isStale && <span data-testid="stale-label">Stale</span>}
      <span data-testid="device-count">{deviceCount} device{deviceCount !== 1 ? 's' : ''}</span>
      {res && <span data-testid="slots">{res.slotsAvailable}/{res.slotsTotal} slots</span>}
      {res && !isStale && (
        <>
          <ResourceBar label="CPU" percent={cpuPercent} colorClass="bg-blue-400" />
          <ResourceBar label="RAM" percent={memPercent} colorClass="bg-violet-400" />
        </>
      )}
    </button>
  )
}

const makeResources = (cpuPercent: number, memPercent: number, stale = false) => ({
  cpuPercent,
  memUsedMB: Math.round(memPercent * 160),
  memTotalMB: 16000,
  slotsAvailable: 2,
  slotsTotal: 4,
  reportedAt: stale ? Date.now() - 31_000 : Date.now(),
})

describe('getResourceHealth', () => {
  it('resources가 없으면 unknown을 반환한다', () => {
    expect(getResourceHealth(undefined, false)).toBe('unknown')
  })

  it('stale이면 unknown을 반환한다', () => {
    expect(getResourceHealth(makeResources(10, 10), true)).toBe('unknown')
  })

  it('CPU와 RAM 모두 70% 미만이면 healthy를 반환한다', () => {
    expect(getResourceHealth(makeResources(50, 50), false)).toBe('healthy')
  })

  it('CPU가 70% 이상이면 warning을 반환한다', () => {
    expect(getResourceHealth(makeResources(70, 30), false)).toBe('warning')
  })

  it('RAM이 70% 이상이면 warning을 반환한다', () => {
    expect(getResourceHealth(makeResources(30, 70), false)).toBe('warning')
  })

  it('CPU가 80%를 초과하면 overloaded를 반환한다', () => {
    expect(getResourceHealth(makeResources(81, 30), false)).toBe('overloaded')
  })

  it('RAM이 80%를 초과하면 overloaded를 반환한다', () => {
    expect(getResourceHealth(makeResources(30, 81), false)).toBe('overloaded')
  })

  it('CPU가 정확히 80%이면 블록하지 않는다 (relay와 동일한 > 기준)', () => {
    expect(getResourceHealth(makeResources(80, 30), false)).toBe('warning')
  })
})

describe('ResourceBar', () => {
  it('레이블과 퍼센트를 렌더링한다', () => {
    render(<ResourceBar label="CPU" percent={42} colorClass="bg-blue-400" />)
    expect(screen.getByText('CPU')).toBeInTheDocument()
    expect(screen.getByText('42%')).toBeInTheDocument()
  })

  it('100% 초과 값을 100%로 클램프한다', () => {
    render(<ResourceBar label="RAM" percent={150} colorClass="bg-violet-400" />)
    const fill = screen.getByTestId('bar-fill')
    expect(fill.style.width).toBe('100%')
  })

  it('0% 값은 width 0%를 렌더링한다', () => {
    render(<ResourceBar label="CPU" percent={0} colorClass="bg-blue-400" />)
    const fill = screen.getByTestId('bar-fill')
    expect(fill.style.width).toBe('0%')
  })
})

describe('MacCard', () => {
  const baseSession: SessionInfo = {
    agentName: 'Mac-A',
    devices: [{ platform: 'ios' }, { platform: 'ios' }],
    resources: {
      cpuPercent: 30,
      memUsedMB: 4096,
      memTotalMB: 16384,
      slotsAvailable: 2,
      slotsTotal: 2,
      reportedAt: Date.now(),
    },
  }

  it('agentName과 디바이스 수를 렌더링한다', () => {
    render(<MacCard session={baseSession} />)
    expect(screen.getByTestId('agent-name')).toHaveTextContent('Mac-A')
    expect(screen.getByTestId('device-count')).toHaveTextContent('2 devices')
  })

  it('단수 디바이스일 때 "device"로 표시한다', () => {
    const session = { ...baseSession, devices: [{ platform: 'ios' }] }
    render(<MacCard session={session} />)
    expect(screen.getByTestId('device-count')).toHaveTextContent('1 device')
  })

  it('resources가 있을 때 슬롯과 CPU/RAM 막대를 렌더링한다', () => {
    render(<MacCard session={baseSession} />)
    expect(screen.getByTestId('slots')).toHaveTextContent('2/2 slots')
    expect(screen.getByText('CPU')).toBeInTheDocument()
    expect(screen.getByText('RAM')).toBeInTheDocument()
  })

  it('resources가 없을 때 CPU/RAM 막대를 렌더링하지 않는다', () => {
    const session: SessionInfo = { agentName: 'Mac-B', devices: [], resources: undefined }
    render(<MacCard session={session} />)
    expect(screen.queryByText('CPU')).not.toBeInTheDocument()
    expect(screen.queryByText('RAM')).not.toBeInTheDocument()
  })

  it('30초 초과 stale resources에 Stale 라벨을 표시한다', () => {
    const staleSession: SessionInfo = {
      ...baseSession,
      resources: { ...baseSession.resources!, reportedAt: Date.now() - 31_000 },
    }
    render(<MacCard session={staleSession} />)
    expect(screen.getByTestId('stale-label')).toBeInTheDocument()
  })

  it('stale 상태에서는 CPU/RAM 막대를 숨긴다', () => {
    const staleSession: SessionInfo = {
      ...baseSession,
      resources: { ...baseSession.resources!, reportedAt: Date.now() - 31_000 },
    }
    render(<MacCard session={staleSession} />)
    expect(screen.queryByText('CPU')).not.toBeInTheDocument()
    expect(screen.queryByText('RAM')).not.toBeInTheDocument()
  })

  it('최신 resources에서는 Stale 라벨을 표시하지 않는다', () => {
    render(<MacCard session={baseSession} />)
    expect(screen.queryByTestId('stale-label')).not.toBeInTheDocument()
  })

  it('RAM 퍼센트를 memUsedMB / memTotalMB 비율로 계산한다', () => {
    // 4096 / 16384 = 25%
    render(<MacCard session={baseSession} />)
    expect(screen.getByText('25%')).toBeInTheDocument()
  })

  it('onClick 핸들러가 카드 클릭 시 호출된다', async () => {
    const user = userEvent.setup()
    let clicked = false
    render(<MacCard session={baseSession} onClick={() => { clicked = true }} />)
    await user.click(screen.getByTestId('mac-card'))
    expect(clicked).toBe(true)
  })

  it('healthy 상태에서 health-dot이 healthy로 렌더링된다', () => {
    render(<MacCard session={baseSession} />)
    expect(screen.getByTestId('health-dot')).toHaveAttribute('data-health', 'healthy')
  })

  it('CPU 71%일 때 warning 상태 닷을 렌더링한다', () => {
    const session = { ...baseSession, resources: makeResources(71, 30) }
    render(<MacCard session={session} />)
    expect(screen.getByTestId('health-dot')).toHaveAttribute('data-health', 'warning')
  })

  it('CPU 81%일 때 overloaded 상태 닷을 렌더링하고 카드를 disable한다', () => {
    const session = { ...baseSession, resources: makeResources(81, 30) }
    render(<MacCard session={session} />)
    expect(screen.getByTestId('health-dot')).toHaveAttribute('data-health', 'overloaded')
    expect(screen.getByTestId('mac-card')).toBeDisabled()
  })

  it('overloaded 카드에 tooltip title이 있다', () => {
    const session = { ...baseSession, resources: makeResources(81, 30) }
    render(<MacCard session={session} />)
    expect(screen.getByTestId('mac-card')).toHaveAttribute('title', 'This Mac is currently overloaded. Try again later.')
  })

  it('overloaded 카드는 클릭해도 onClick이 호출되지 않는다', async () => {
    const user = userEvent.setup()
    let clicked = false
    const session = { ...baseSession, resources: makeResources(81, 30) }
    render(<MacCard session={session} onClick={() => { clicked = true }} />)
    await user.click(screen.getByTestId('mac-card'))
    expect(clicked).toBe(false)
  })

  it('resources 없으면 unknown 닷을 렌더링하고 카드는 활성 상태다', () => {
    const session: SessionInfo = { agentName: 'Mac-B', devices: [], resources: undefined }
    render(<MacCard session={session} />)
    expect(screen.getByTestId('health-dot')).toHaveAttribute('data-health', 'unknown')
    expect(screen.getByTestId('mac-card')).not.toBeDisabled()
  })
})
