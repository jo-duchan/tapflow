import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useRelay } from '@/hooks/useRelay';
import { useBreadcrumb } from '@/hooks/useBreadcrumb';
import { DeviceViewer } from '@/components/DeviceViewer';
import { SessionPanel } from '@/components/session-panel';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink,
  BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { getBuild } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { STATUS_TONE, buildLabel } from '@/lib/build-format';
import { Info } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { SearchInput } from '@/components/ui/search-input';
import type { AgentDevice, Build, RelayMessage, SessionInfo } from '@/lib/types';

export function QASession() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const buildId = searchParams.get('id');

  const [build, setBuild] = useState<Build | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string>('');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [booting, setBooting] = useState(false);
  const [status, setStatus] = useState('');
  const [recordingsKey, setRecordingsKey] = useState(0);
  const [resetMode, setResetMode] = useState<'app-only' | 'full-erase'>('app-only');

  useEffect(() => {
    if (!buildId) return;
    getBuild(buildId).then(setBuild);
  }, [buildId]);

  const handleMessage = useCallback((msg: RelayMessage) => {
    if (msg.type === 'agents:listed') {
      setSessions(msg.sessions);
    }
    if (msg.type === 'session:joined') {
      setBooting(false);
      setStatus('Connected');
    }
    if (msg.type === 'error') {
      setBooting(false);
      setStatus(`Error: ${msg.message}`);
    }
  }, []);

  const { send, connected } = useRelay(handleMessage);

  // 5초마다 polling — 슬롯·자원 최신화
  useEffect(() => {
    if (!connected) return;
    send({ type: 'agents:list' });
    const id = setInterval(() => send({ type: 'agents:list' }), 5000);
    return () => clearInterval(id);
  }, [connected, send]);

  const os = build?.platform ?? 'ios';
  const agentGroups = sessions.filter((s) => s.devices.some((d) => d.platform === os));
  const selectedSession = agentGroups.find((s) => s.agentName === selectedAgent);
  const filteredDevices = selectedSession?.devices.filter((d) => d.platform === os) ?? [];
  const allDevices = sessions.flatMap((s) => s.devices);
  const selectedDevice = allDevices.find((d) => d.id === deviceId);
  const deviceLabel = selectedDevice
    ? `${selectedDevice.name}${selectedDevice.osVersion ? ` · ${selectedDevice.osVersion}` : ''}`
    : '';

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
  }) as string[];
  const [osVersion, setOsVersion] = useState<string>('');
  const [deviceSearch, setDeviceSearch] = useState('');

  const versionedDevices = (osVersion
    ? filteredDevices.filter((d) => d.osVersion === osVersion)
    : filteredDevices
  ).filter((d) => !deviceSearch || d.name.toLowerCase().includes(deviceSearch.toLowerCase()));

  // DeviceViewer → 디바이스 선택
  const handleBack = useCallback(() => {
    if (activeSessionId && deviceId) {
      send({ type: 'device:shutdown', sessionId: activeSessionId, payload: { deviceId } });
    }
    setActiveSessionId(null);
    setBooting(false);
    setStatus('');
  }, [activeSessionId, deviceId, send]);

  // 디바이스 선택 → Mac 선택
  const handleBackToMacs = useCallback(() => {
    if (activeSessionId && deviceId) {
      send({ type: 'device:shutdown', sessionId: activeSessionId, payload: { deviceId } });
    }
    setActiveSessionId(null);
    setSelectedAgent(null);
    setBooting(false);
    setStatus('');
  }, [activeSessionId, deviceId, send]);

  // ref로 최신 session 정보를 추적 — cleanup 클로저에서 stale state 방지
  const activeSessionRef = useRef({ sessionId: activeSessionId, deviceId });
  useEffect(() => {
    activeSessionRef.current = { sessionId: activeSessionId, deviceId };
  }, [activeSessionId, deviceId]);

  // 언마운트 시 디바이스 shutdown — useRelay cleanup(ws.close)보다 먼저 실행됨
  useEffect(() => {
    return () => {
      const { sessionId, deviceId: dId } = activeSessionRef.current;
      if (sessionId && dId) {
        send({ type: 'device:shutdown', sessionId, payload: { deviceId: dId } });
      }
    };
  }, [send]);

  // 헤더 breadcrumb 설정
  const { setNode: setBreadcrumb } = useBreadcrumb();
  useEffect(() => {
    if (!build) return;
    setBreadcrumb(
      <div className="flex items-center gap-3">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <button onClick={() => navigate(`/app-center?appId=${build.app_id}`)}>
                  {build.name}
                </button>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              {selectedAgent ? (
                <BreadcrumbLink asChild>
                  <button onClick={handleBackToMacs}>{buildLabel(build)}</button>
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage>{buildLabel(build)}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
            {selectedAgent && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  {activeSessionId ? (
                    <BreadcrumbLink asChild>
                      <button onClick={handleBack}>{selectedAgent}</button>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>{selectedAgent}</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
              </>
            )}
            {activeSessionId && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{deviceLabel}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
          </BreadcrumbList>
        </Breadcrumb>
        {!selectedAgent && build.status_label && (
          <Badge tone={STATUS_TONE[build.status_label as keyof typeof STATUS_TONE]}>
            {build.status_label}
          </Badge>
        )}
      </div>
    );
    return () => setBreadcrumb(null);
  }, [build, selectedAgent, activeSessionId, deviceLabel, navigate, handleBack, handleBackToMacs, setBreadcrumb]);

  return (
    <div className="flex h-full min-h-0 gap-6 p-6">
      <div className="flex flex-col gap-3 flex-1 min-w-0 min-h-0">
        {/* -ml-1 pl-1: 좌측 ring 클리핑 방지 / -mr-4 pr-4: 스크롤바 마진 영역으로 분리 */}
        <div className="flex-1 min-h-0 overflow-auto -ml-1 pl-1 -mr-4 pr-4">
          {activeSessionId ? (
            <div className="min-h-full flex items-center justify-center py-6 px-8 min-w-max">
              <DeviceViewer
                sessionId={activeSessionId}
                deviceId={deviceId}
                buildId={build?.id}
                resetMode={resetMode}
                onRecordingUploaded={() => setRecordingsKey((k) => k + 1)}
              />
            </div>
          ) : selectedAgent ? (
            <div className="flex flex-col gap-5">
              <div className="flex items-center gap-3">
                <button
                  onClick={handleBackToMacs}
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  ← All Macs
                </button>
                <h1 className="text-xl font-semibold tracking-tight">Select device</h1>
              </div>

              <div className="flex items-center gap-2">
                <SearchInput
                  placeholder="Search device…"
                  value={deviceSearch}
                  onChange={setDeviceSearch}
                />
                {osVersions.length > 0 && (
                  <Select
                    value={osVersion || '__all__'}
                    onValueChange={(v) => {
                      setOsVersion(v === '__all__' ? '' : v);
                      setDeviceId('');
                    }}
                  >
                    <SelectTrigger className="h-8 w-36 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">Any version</SelectItem>
                      {osVersions.map((v) => (
                        <SelectItem key={v} value={v}>{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <TooltipProvider>
                  <Tooltip>
                    <div className="ml-auto flex items-center gap-2 shrink-0">
                      <TooltipTrigger asChild>
                        <Label htmlFor="reset-mode" className="flex items-center gap-1 text-sm cursor-pointer whitespace-nowrap">
                          <Info className="h-3.5 w-3.5 text-muted-foreground" />
                          Full reset
                        </Label>
                      </TooltipTrigger>
                      <Switch
                        id="reset-mode"
                        checked={resetMode === 'full-erase'}
                        onCheckedChange={(checked) => setResetMode(checked ? 'full-erase' : 'app-only')}
                      />
                    </div>
                    <TooltipContent>
                      {resetMode === 'full-erase' ? 'Erase all data before booting' : 'Keep existing data'}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>

              {versionedDevices.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {connected ? 'No devices available for this OS.' : 'Connecting to relay…'}
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {versionedDevices.map((d: AgentDevice) => {
                    const isBooted = d.status === 'booted'
                    const isBusy = d.busy
                    const statusLabel = isBusy ? 'In use' : isBooted ? 'Booted' : 'Available'
                    const statusDot = isBusy
                      ? 'bg-amber-400'
                      : isBooted
                        ? 'bg-emerald-400'
                        : 'bg-muted-foreground/40'
                    return (
                      <button
                        key={d.id}
                        disabled={isBusy || booting || !connected}
                        onClick={() => {
                          setDeviceId(d.id)
                          setBooting(true)
                          setStatus('Booting…')
                          setActiveSessionId(d.sessionId)
                        }}
                        className={cn(
                          'flex flex-col gap-3 rounded-lg border p-3 text-left transition-colors min-h-[100px]',
                          'hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
                        )}
                      >
                        <span className="text-sm font-medium leading-tight">{d.name}</span>
                        {d.osVersion && (
                          <span className="font-mono text-xs text-muted-foreground">{d.osVersion}</span>
                        )}
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className={cn('inline-block h-1.5 w-1.5 rounded-full', statusDot)} />
                          {statusLabel}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}

              {status && <p className="text-sm text-muted-foreground">{status}</p>}
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <h1 className="text-xl font-semibold tracking-tight">Select Mac</h1>

              {agentGroups.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {connected ? `No agents available for ${os}.` : 'Connecting to relay…'}
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {agentGroups.map((s: SessionInfo) => {
                    const res = s.resources
                    const isStale = res ? Date.now() - res.reportedAt > 30_000 : false
                    const deviceCount = s.devices.filter((d) => d.platform === os).length
                    const cpuPercent = res?.cpuPercent ?? 0
                    const memPercent = res ? (res.memUsedMB / res.memTotalMB) * 100 : 0
                    return (
                      <button
                        key={s.agentName}
                        onClick={() => setSelectedAgent(s.agentName ?? null)}
                        className={cn(
                          'flex flex-col gap-3 rounded-lg border p-3 text-left transition-colors min-h-[100px]',
                          'hover:bg-accent',
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-sm font-medium leading-tight truncate">
                            {s.agentName ?? 'Unknown'}
                          </span>
                          {isStale && (
                            <span className="shrink-0 text-[10px] font-medium text-amber-500">Stale</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span>{deviceCount} device{deviceCount !== 1 ? 's' : ''}</span>
                          {res && (
                            <>
                              <span>·</span>
                              <span>{res.slotsAvailable}/{res.slotsTotal} slots</span>
                            </>
                          )}
                        </div>
                        {res && !isStale && (
                          <div className="flex flex-col gap-1.5 w-full">
                            <ResourceBar label="CPU" percent={cpuPercent} colorClass="bg-blue-400" />
                            <ResourceBar label="RAM" percent={memPercent} colorClass="bg-violet-400" />
                          </div>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {buildId && (
        <>
          <Separator orientation="vertical" className="h-auto" />
          <div className="w-80 shrink-0 h-full">
            <SessionPanel
              buildId={Number(buildId)}
              recordingsRefreshKey={recordingsKey}
            />
          </div>
        </>
      )}
    </div>
  );
}

function ResourceBar({ label, percent, colorClass }: { label: string; percent: number; colorClass: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span>{percent.toFixed(0)}%</span>
      </div>
      <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', colorClass)}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
    </div>
  );
}
