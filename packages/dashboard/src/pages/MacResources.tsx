import { useCallback, useEffect, useState } from 'react'
import { useRelay } from '@/hooks/useRelay'
import { useBreadcrumb } from '@/hooks/useBreadcrumb'
import { Monitor } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { LineChart, Line, XAxis, YAxis, CartesianGrid } from 'recharts'
import type { RelayMessage, SessionInfo } from '@/lib/types'

interface ResourcePoint {
  cpu_percent: number
  mem_percent: number
  recorded_at: string
}

type Range = '1h' | '6h' | '24h' | '7d'

const chartConfig = {
  cpu: { label: 'CPU', color: 'hsl(var(--chart-1))' },
  mem: { label: 'RAM', color: 'hsl(var(--chart-2))' },
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

  const connectedSet = new Set(connectedNames)

  return (
    <div className="flex flex-col gap-6 p-6 h-full min-h-0">
      {allAgents.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-2 text-muted-foreground">
          <Monitor className="h-8 w-8" />
          <p className="text-sm">{connected ? 'No agents connected yet.' : 'Connecting to relay…'}</p>
        </div>
      ) : (
        <>
          {/* Agent tabs */}
          <div className="flex flex-wrap gap-2">
            {allAgents.map((name) => {
              const isOnline = connectedSet.has(name)
              const isSelected = selectedAgent === name
              return (
                <button
                  key={name}
                  onClick={() => setSelectedAgent(name)}
                  className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors
                    ${isSelected ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-accent'}`}
                >
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${isOnline ? 'bg-emerald-400' : 'bg-muted-foreground/40'}`} />
                  {name}
                </button>
              )
            })}
          </div>

          {/* Graph area */}
          {selectedAgent && (
            <div className="flex flex-col gap-4 flex-1 min-h-0">
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
                <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">Loading…</div>
              ) : chartData.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                  No data yet for this range. Data is collected every minute while the agent is connected.
                </div>
              ) : (
                <div className="flex flex-col gap-6 flex-1">
                  <ChartCard title="CPU %" color="cpu" data={chartData} dataKey="cpu" range={range} formatTick={formatTick} />
                  <ChartCard title="RAM %" color="mem" data={chartData} dataKey="mem" range={range} formatTick={formatTick} />
                </div>
              )}
            </div>
          )}
        </>
      )}
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

  return (
    <div className="rounded-lg border p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: `hsl(var(--${color === 'cpu' ? 'chart-1' : 'chart-2'}))` }} />
        <span className="text-sm font-medium">{title}</span>
      </div>
      <ChartContainer config={chartConfig} className="h-[140px] w-full">
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
          <XAxis
            dataKey="time"
            ticks={ticks}
            tickFormatter={(v) => formatTick(v, range)}
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            domain={[0, 100]}
            tickFormatter={(v) => `${v}%`}
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={36}
          />
          <ChartTooltip
            content={<ChartTooltipContent formatter={(v) => `${v}%`} />}
          />
          <Line
            type="monotone"
            dataKey={dataKey}
            stroke={`hsl(var(--${color === 'cpu' ? 'chart-1' : 'chart-2'}))`}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ChartContainer>
    </div>
  )
}
