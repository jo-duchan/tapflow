import { useCallback, useEffect, useState } from 'react'
import { useRelay } from '@/hooks/useRelay'
import { useBreadcrumb } from '@/hooks/useBreadcrumb'
import { Monitor } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid } from 'recharts'
import type { RelayMessage, SessionInfo } from '@/lib/types'

interface ResourcePoint {
  cpu_percent: number
  mem_percent: number
  recorded_at: string
}

type Range = '1h' | '6h' | '24h' | '7d'

const chartConfig = {
  cpu: { label: 'CPU', color: '#60a5fa' },
  mem: { label: 'RAM', color: '#a78bfa' },
} satisfies ChartConfig

const RANGE_LABELS: Record<Range, string> = { '1h': '1h', '6h': '6h', '24h': '24h', '7d': '7d' }

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
      .then(setPoints)
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
                <span className="truncate">{name}</span>
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
                <ChartCard title="CPU %" color="cpu" data={chartData} dataKey="cpu" range={range} formatTick={formatTick} />
                <ChartCard title="RAM %" color="mem" data={chartData} dataKey="mem" range={range} formatTick={formatTick} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ChartCard({
  title,
  color,
  data,
  dataKey,
  range,
  formatTick,
}: {
  title: string
  color: keyof typeof chartConfig
  data: { time: string; cpu: number; mem: number }[]
  dataKey: 'cpu' | 'mem'
  range: Range
  formatTick: (iso: string, range: Range) => string
}) {
  const tickCount = Math.min(data.length, range === '7d' ? 7 : range === '24h' ? 8 : 6)
  const step = Math.max(1, Math.floor(data.length / tickCount))
  const ticks = data.filter((_, i) => i % step === 0).map((d) => d.time)
  const lastTime = data[data.length - 1]?.time
  if (lastTime && !ticks.includes(lastTime)) ticks.push(lastTime)

  return (
    <div className="rounded-lg border p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color === 'cpu' ? '#60a5fa' : '#a78bfa' }} />
        <span className="text-sm font-medium">{title}</span>
      </div>
      <ChartContainer config={chartConfig} className="h-[220px] w-full">
        <AreaChart data={data} margin={{ top: 8, right: 24, bottom: 24, left: 8 }}>
          <defs>
            <linearGradient id={`fill-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color === 'cpu' ? '#60a5fa' : '#a78bfa'} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color === 'cpu' ? '#60a5fa' : '#a78bfa'} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
          <XAxis
            dataKey="time"
            ticks={ticks}
            tickFormatter={(v) => formatTick(v, range)}
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            dy={6}
            padding={{ left: 16, right: 16 }}
          />
          <YAxis
            domain={[0, 100]}
            ticks={[0, 25, 50, 75, 100]}
            tickFormatter={(v) => `${v}%`}
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={40}
            dx={-4}
            padding={{ top: 16, bottom: 0 }}
          />
          <ChartTooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const d = new Date(payload[0].payload.time)
              const dateStr = d.toLocaleString('ko-KR', {
                month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: false,
              })
              const value = payload[0].value as number
              return (
                <div className="rounded-lg border bg-background px-3 py-2 shadow-md text-xs">
                  <p className="mb-1">Date: {dateStr}</p>
                  <p>{chartConfig[dataKey].label}: {value}%</p>
                </div>
              )
            }}
          />
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke={color === 'cpu' ? '#60a5fa' : '#a78bfa'}
            strokeWidth={1.5}
            fill={`url(#fill-${dataKey})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ChartContainer>
    </div>
  )
}
