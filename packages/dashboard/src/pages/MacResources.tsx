import { useCallback, useEffect, useState } from 'react'
import { useRelay } from '@/hooks/useRelay'
import { useBreadcrumb } from '@/hooks/useBreadcrumb'
import { Monitor } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { scaleTime, scaleLinear } from '@visx/scale'
import { AreaClosed, LinePath, Bar, Line } from '@visx/shape'
import { AxisBottom, AxisLeft } from '@visx/axis'
import { GridRows } from '@visx/grid'
import { LinearGradient } from '@visx/gradient'
import { Group } from '@visx/group'
import { ParentSize } from '@visx/responsive'
import { useTooltip } from '@visx/tooltip'
import { localPoint } from '@visx/event'
import { curveMonotoneX } from '@visx/curve'
import { bisector } from 'd3-array'
import type { RelayMessage, SessionInfo } from '@/lib/types'

interface ResourcePoint {
  cpu_percent: number
  mem_percent: number
  recorded_at: string
}

type Range = '1h' | '6h' | '24h' | '7d'

type ChartConfig = Record<string, { label: string; color: string }>

const chartConfig = {
  cpu: { label: 'CPU', color: '#60a5fa' },
  mem: { label: 'RAM', color: '#a78bfa' },
} satisfies ChartConfig

const RANGE_LABELS: Record<Range, string> = { '1h': '1h', '6h': '6h', '24h': '24h', '7d': '7d' }
const RANGE_MS: Record<Range, number> = { '1h': 3_600_000, '6h': 21_600_000, '24h': 86_400_000, '7d': 604_800_000 }
// Clean tick spacing per range (1h→10m, 6h→1h, 24h→3h, 7d→1d).
const TICK_STEP_MS: Record<Range, number> = { '1h': 600_000, '6h': 3_600_000, '24h': 10_800_000, '7d': 86_400_000 }

function formatTick(iso: string, range: Range): string {
  const d = new Date(iso)
  if (range === '7d') return `${d.getMonth() + 1}/${d.getDate()}`
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function MacResources() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [knownAgents, setKnownAgents] = useState<string[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [range, setRange] = useState<Range>('24h')
  const [points, setPoints] = useState<ResourcePoint[]>([])
  const [fetchedAt, setFetchedAt] = useState(() => Date.now())
  const [loading, setLoading] = useState(false)

  const { setNode: setBreadcrumb } = useBreadcrumb()
  useEffect(() => {
    setBreadcrumb(<span className="text-sm font-medium">Mac Resources</span>)
    return () => setBreadcrumb(null)
  }, [setBreadcrumb])

  const handleMessage = useCallback((msg: RelayMessage) => {
    if (msg.type === 'agents:listed') setSessions(msg.sessions ?? [])
  }, [])
  const { send, connected } = useRelay(handleMessage)

  useEffect(() => {
    if (!connected) return
    send({ type: 'agents:list' })
    const id = setInterval(() => send({ type: 'agents:list' }), 10_000)
    return () => clearInterval(id)
  }, [connected, send])

  useEffect(() => {
    fetch('/api/v1/agents', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then(setKnownAgents)
  }, [])

  const connectedNames = sessions.map((s) => s.agentName).filter(Boolean) as string[]
  const allAgents = [...new Set([...connectedNames, ...knownAgents])]
  const connectedSet = new Set(connectedNames)

  useEffect(() => {
    if (!selectedAgent && allAgents.length > 0) setSelectedAgent(allAgents[0])
  }, [allAgents.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedAgent) return
    setLoading(true)
    fetch(`/api/v1/agents/${encodeURIComponent(selectedAgent)}/resources?range=${range}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        setPoints(data)
        setFetchedAt(Date.now())
      })
      .finally(() => setLoading(false))
  }, [selectedAgent, range])

  const chartData = points.map((p) => ({
    time: p.recorded_at,
    cpu: Math.round(p.cpu_percent * 10) / 10,
    mem: Math.round(p.mem_percent * 10) / 10,
  }))

  return (
    <div className="flex h-full min-h-0">
      {/* Macs sidebar */}
      <aside className="w-64 shrink-0 border-r flex flex-col gap-1 p-3 overflow-y-auto">
        <span className="px-2 pb-1 font-mono text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Macs
        </span>
        {allAgents.length === 0 ? (
          <span className="px-2 text-sm text-muted-foreground">
            {connected ? 'No agents yet.' : 'Connecting…'}
          </span>
        ) : (
          allAgents.map((name) => {
            const isOnline = connectedSet.has(name)
            const isSelected = selectedAgent === name
            return (
              <button
                key={name}
                onClick={() => setSelectedAgent(name)}
                className={[
                  'flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent transition-colors',
                  isSelected ? 'bg-accent font-medium' : '',
                ].join(' ')}
              >
                <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${isOnline ? 'bg-emerald-400' : 'bg-muted-foreground/40'}`} />
                <span className="truncate min-w-0">{name}</span>
              </button>
            )
          })
        )}
      </aside>

      {/* Main content */}
      <div className="flex-1 min-w-0 overflow-auto">
        {!selectedAgent ? (
          <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
            <Monitor className="h-8 w-8" />
            <p className="text-sm">Select a Mac to view resource history.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-6 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">{selectedAgent}</h2>
              <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
                <TabsList>
                  {(Object.keys(RANGE_LABELS) as Range[]).map((r) => (
                    <TabsTrigger key={r} value={r}>{RANGE_LABELS[r]}</TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>

            {loading ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Loading…</div>
            ) : chartData.length === 0 ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                No data yet for this range. Data is collected every minute while the agent is connected.
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                <ChartCard title="CPU %" color="cpu" data={chartData} dataKey="cpu" range={range} now={fetchedAt} />
                <ChartCard title="RAM %" color="mem" data={chartData} dataKey="mem" range={range} now={fetchedAt} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

type Datum = { time: string; cpu: number; mem: number }

const getTime = (d: Datum) => new Date(d.time).getTime()
const bisectTime = bisector<Datum, number>(getTime).left

const MARGIN = { top: 8, right: 24, bottom: 24, left: 40 }
const INSET = 16 // left/right breathing room inside the plot area

function ChartCard({
  title,
  color,
  data,
  dataKey,
  range,
  now,
}: {
  title: string
  color: keyof typeof chartConfig
  data: Datum[]
  dataKey: 'cpu' | 'mem'
  range: Range
  now: number
}) {
  const hex = color === 'cpu' ? '#60a5fa' : '#a78bfa'

  return (
    <div className="rounded-lg border p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: hex }} />
        <span className="text-sm font-medium">{title}</span>
      </div>
      <div className="relative h-[220px] w-full">
        <ParentSize>
          {({ width, height }) =>
            width > 0 && height > 0 ? (
              <AreaChartInner width={width} height={height} data={data} dataKey={dataKey} hex={hex} range={range} now={now} label={chartConfig[dataKey].label} />
            ) : null
          }
        </ParentSize>
      </div>
    </div>
  )
}

function AreaChartInner({
  width,
  height,
  data,
  dataKey,
  hex,
  range,
  now,
  label,
}: {
  width: number
  height: number
  data: Datum[]
  dataKey: 'cpu' | 'mem'
  hex: string
  range: Range
  now: number
  label: string
}) {
  const { showTooltip, hideTooltip, tooltipData, tooltipLeft, tooltipTop } = useTooltip<Datum>()

  const innerW = width - MARGIN.left - MARGIN.right
  const innerH = height - MARGIN.top - MARGIN.bottom

  // Fixed window anchored to the fetch time. Round the right edge up to a clean
  // boundary so ticks land on round times (e.g. 23:50, 00:00) instead of 00:47.
  const step = TICK_STEP_MS[range]
  const maxT = Math.ceil(now / step) * step
  const minT = maxT - RANGE_MS[range]
  const xScale = scaleTime({ domain: [minT, maxT], range: [INSET, Math.max(INSET, innerW - INSET)] })
  const yScale = scaleLinear({ domain: [0, 100], range: [innerH, INSET] })
  // Even, clean-stepped ticks across the whole window so the axis always spans
  // the full range regardless of where data exists.
  const ticks = Array.from({ length: RANGE_MS[range] / step + 1 }, (_, i) => new Date(minT + i * step))

  const gradId = `fill-${dataKey}`

  const handleMove = (e: React.MouseEvent<SVGRectElement> | React.TouchEvent<SVGRectElement>) => {
    const point = localPoint(e)
    if (!point) return
    const t0 = xScale.invert(point.x - MARGIN.left).getTime()
    const i = bisectTime(data, t0)
    const lo = data[i - 1]
    const hi = data[i]
    const d = lo && hi ? (t0 - getTime(lo) < getTime(hi) - t0 ? lo : hi) : (lo ?? hi)
    if (!d) return
    showTooltip({ tooltipData: d, tooltipLeft: xScale(getTime(d)), tooltipTop: yScale(d[dataKey]) })
  }

  return (
    <>
      <svg width={width} height={height}>
        <LinearGradient id={gradId} from={hex} to={hex} fromOpacity={0.3} toOpacity={0} fromOffset="5%" toOffset="95%" />
        <Group left={MARGIN.left} top={MARGIN.top}>
          <GridRows scale={yScale} width={innerW} tickValues={[0, 25, 50, 75, 100]} strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <AreaClosed<Datum>
            data={data}
            x={(d) => xScale(getTime(d))}
            y={(d) => yScale(d[dataKey])}
            yScale={yScale}
            curve={curveMonotoneX}
            fill={`url(#${gradId})`}
          />
          <LinePath<Datum>
            data={data}
            x={(d) => xScale(getTime(d))}
            y={(d) => yScale(d[dataKey])}
            curve={curveMonotoneX}
            stroke={hex}
            strokeWidth={1.5}
          />
          <AxisBottom
            top={innerH}
            scale={xScale}
            tickValues={ticks}
            tickFormat={(v) => formatTick(new Date(+v).toISOString(), range)}
            hideAxisLine
            hideTicks
            tickLength={0}
            tickLabelProps={(_v, index, all) => ({
              fontSize: 11,
              fill: 'currentColor',
              textAnchor: index === 0 ? 'start' : index === all.length - 1 ? 'end' : 'middle',
              dy: 6,
              className: 'fill-muted-foreground',
            })}
          />
          <AxisLeft
            scale={yScale}
            tickValues={[0, 25, 50, 75, 100]}
            tickFormat={(v) => `${v}%`}
            hideAxisLine
            hideTicks
            tickLabelProps={() => ({ fontSize: 11, fill: 'currentColor', textAnchor: 'end', dx: -4, dy: 3, className: 'fill-muted-foreground' })}
          />
          {tooltipData && (
            <g style={{ transition: 'transform 0.25s ease-out', transform: `translateX(${tooltipLeft ?? 0}px)` }} pointerEvents="none">
              <Line from={{ x: 0, y: INSET }} to={{ x: 0, y: innerH }} stroke="hsl(var(--border))" strokeWidth={1} />
              <circle cx={0} cy={0} r={3} fill={hex} stroke="hsl(var(--background))" strokeWidth={1.5} style={{ transition: 'transform 0.25s ease-out', transform: `translateY(${tooltipTop ?? 0}px)` }} />
            </g>
          )}
          <Bar
            x={0}
            y={0}
            width={Math.max(0, innerW)}
            height={Math.max(0, innerH)}
            fill="transparent"
            onMouseMove={handleMove}
            onMouseLeave={hideTooltip}
            onTouchMove={handleMove}
          />
        </Group>
      </svg>
      {tooltipData && (
        <div
          className="pointer-events-none absolute top-0 left-0 whitespace-nowrap rounded-lg border bg-background px-3 py-2 text-xs text-foreground shadow-md"
          style={{
            // transform (not left/top) so position eases smoothly like recharts
            transform: `translate(${(tooltipLeft ?? 0) + MARGIN.left}px, ${(tooltipTop ?? 0) + MARGIN.top}px) translate(${(tooltipLeft ?? 0) > innerW * 0.6 ? 'calc(-100% - 12px)' : '12px'}, -50%)`,
            transition: 'transform 0.25s ease-out',
          }}
        >
          <p className="mb-1">
            Date:{' '}
            {new Date(tooltipData.time).toLocaleString('ko-KR', {
              month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
            })}
          </p>
          <p>
            {label}: {Math.round(tooltipData[dataKey] * 10) / 10}%
          </p>
        </div>
      )}
    </>
  )
}
