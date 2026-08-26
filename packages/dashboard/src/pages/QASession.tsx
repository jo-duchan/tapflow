import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { SessionTerminatedReason } from '@tapflowio/protocol';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useBreadcrumb } from '@/hooks/useBreadcrumb';
import { useBuildLoader } from '@/hooks/useBuildLoader';
import { useAgentSession } from '@/hooks/useAgentSession';
import { useDeviceSelector } from '@/hooks/useDeviceSelector';
import { DeviceViewer } from '@/components/DeviceViewer';
import { SessionPanel } from '@/components/SessionPanel';
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
import { cn } from '@/lib/utils';
import { STATUS_TONE, buildLabel } from '@/lib/build-format';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { SearchInput } from '@/components/ui/search-input';
import type { DeviceSummary, SessionInfo } from '@/lib/types';
import { getResourceHealth, type ResourceHealth } from '@/lib/resource-health';

/** Why this viewer stopped — a superset of the relay's termination reasons; see `DeviceViewer`'s prop. */
type ViewerStoppedReason = SessionTerminatedReason | 'busy-elsewhere' | 'mac-overloaded';

// Keyed by the reason so a new one cannot be added without deciding what the user is told. A
// callback that ignored `reason` would keep showing "the agent disconnected" for every future
// cause — which is exactly what the literal union exists to prevent.
const SESSION_ENDED_NOTICE: Record<ViewerStoppedReason, { title: string; description: string }> = {
  'agent-disconnected': {
    title: 'The agent disconnected — this session ended.',
    description: 'Pick the Mac again to start a new session.',
  },
  // **This copy used to lead with "it is probably your own tab", and that stopped being the common case.**
  // The relay answered `session-busy` whenever the browser socket still read OPEN, so an automatic
  // reconnect after a Wi-Fi blip collided with its own predecessor — routine, and the reason the wording
  // hedged. A session belongs to a client now (#527), and the reconnect runs inside the same document, so
  // it is recognised and handed back rather than refused.
  //
  // What still self-collides is a **reload** during a blip: a new document is a new identity, and the old
  // socket has not been noticed as gone. So the hedge stays, second rather than first, and names the
  // window that actually applies — the relay stops treating a holder as present about 45 seconds after it
  // last answered, not the 30 this used to quote.
  'busy-elsewhere': {
    title: 'This device is already open in another browser session.',
    description: 'Someone else may be testing it. If you reloaded while your connection was down it is '
      + 'your own tab, and that clears within about 45 seconds.',
  },
  // The Mac is over its ceiling, so a different Mac is the actionable move — and unlike the other two
  // this one is about the machine, not the session.
  'mac-overloaded': {
    title: 'That Mac is too busy to start a session.',
    description: 'Pick a different Mac, or wait for it to settle.',
  },
};

export function QASession() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const buildId = searchParams.get('id');

  const { build } = useBuildLoader(buildId);
  const [recordingsKey, setRecordingsKey] = useState(0);

  const os = build?.platform ?? 'ios';
  const {
    sessions, selectedAgent, setSelectedAgent,
    activeSessionId, deviceId, booting, status,
    connected, agentGroups,
    startDevice, resetDevice, handleBack, handleBackToMacs, handleSessionEnded,
  } = useAgentSession(os);

  // #679 — how much width the viewer actually has on screen (panel/sidebar included), so
  // IOSViewer/AndroidViewer can shrink below their height-only cap on narrow viewports. `0` until
  // measured, which both sides treat as "no constraint yet" (see `widthFitScale`). Depends on
  // `activeSessionId` because the wrapper div only mounts once a session is active.
  const viewerWrapperRef = useRef<HTMLDivElement>(null);
  const [viewerWidthBudget, setViewerWidthBudget] = useState(0);
  useLayoutEffect(() => {
    const el = viewerWrapperRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setViewerWidthBudget(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeSessionId]);

  const selectedSession = agentGroups.find((s) => s.agentName === selectedAgent);
  const {
    osVersions, osVersion, setOsVersion,
    deviceSearch, setDeviceSearch, versionedDevices,
    resetMode, setResetMode, appliedResetMode, consumeResetMode, fullResetSupported,
  } = useDeviceSelector(selectedSession, os);

  const allDevices = sessions.flatMap((s) => s.devices);
  const selectedDevice = allDevices.find((d) => d.id === deviceId);
  const deviceLabel = selectedDevice
    ? `${selectedDevice.name}${selectedDevice.osVersion ? ` · ${selectedDevice.osVersion}` : ''}`
    : '';

  const handleRecordingUploaded = useCallback(() => setRecordingsKey((k) => k + 1), []);

  // Full reset is a one-shot instruction, not a setting. Snapshot it for this launch and turn the
  // toggle off in the same click: the value has to survive because `device:boot` is only sent later,
  // after `session:joined` arrives, and clearing the toggle alone would leave `app-only` in its place.
  // Turning it off here is also what stops the next device from being erased too (#439).
  //
  // Consumed on click, not on success — a failed boot does not re-arm it. Asking again means
  // turning it on again, which keeps an irreversible action tied to an explicit act.
  const handleStartDevice = useCallback((d: DeviceSummary) => {
    consumeResetMode();
    startDevice(d);
  }, [consumeResetMode, startDevice]);

  // The viewer cannot make progress — the agent went away, or another socket holds the session. Say
  // which, and go back to the Mac list. Before #426 the tab just sat on "Waiting for first frame..."
  // with no way to know a refresh was needed; `busy-elsewhere` sat on it just as silently until L6.
  const onSessionEnded = useCallback((reason: ViewerStoppedReason) => {
    const notice = SESSION_ENDED_NOTICE[reason];
    toast.error(notice.title, { description: notice.description });
    handleSessionEnded();
  }, [handleSessionEnded]);

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
    <div data-testid="qa-session-root" className="flex flex-col lg:flex-row h-full min-h-0 gap-6 p-6">
      <div className="flex flex-col gap-3 flex-1 min-w-0 min-h-0">
        {/* -ml-1 pl-1: 좌측 ring 클리핑 방지 / -mr-4 pr-4: 스크롤바 마진 영역으로 분리 */}
        <div className="flex-1 min-h-0 overflow-auto -ml-1 pl-1 -mr-4 pr-4">
          {activeSessionId ? (
            <div ref={viewerWrapperRef} className="min-h-full flex items-center justify-center py-6 px-8">
              <DeviceViewer
                sessionId={activeSessionId}
                deviceId={deviceId}
                buildId={build?.id}
                resetMode={appliedResetMode}
                widthBudget={viewerWidthBudget}
                onRecordingUploaded={handleRecordingUploaded}
                onSessionEnded={onSessionEnded}
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
                      resetDevice();
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
                {/* Absent rather than disabled where nothing acts on it (#447). A disabled control
                    owes the user a reason, and the only channel here is the tooltip — which does
                    not reach touch at all. Showing nothing beats showing a switch that erases
                    nothing and cannot say why. */}
                {fullResetSupported && (
                  <TooltipProvider>
                    <Tooltip>
                      {/* The whole control is the trigger, not the label alone: a label cannot take
                          focus, so a tooltip hung on it is hover-only and the keyboard never sees
                          what this switch destroys. Focus bubbles, so tabbing to the Switch opens
                          it — and the Switch keeps its own `data-state`, which is the only thing
                          colouring its track. */}
                      <TooltipTrigger asChild>
                        <div className="ml-auto flex items-center gap-2 shrink-0">
                          <Label htmlFor="reset-mode" className="text-sm cursor-pointer whitespace-nowrap">
                            Full reset
                          </Label>
                          {/* Said unconditionally for anyone reading the toolbar rather than
                              hovering it — Radix attaches the tooltip's own aria-describedby only
                              while it is open, and on touch it never opens at all. */}
                          <span id="reset-mode-desc" className="sr-only">
                            When on, erases all data on the next device you pick
                          </span>
                          <Switch
                            id="reset-mode"
                            aria-describedby="reset-mode-desc"
                            checked={resetMode === 'full-erase'}
                            onCheckedChange={(checked) => setResetMode(checked ? 'full-erase' : 'app-only')}
                          />
                        </div>
                      </TooltipTrigger>
                      <TooltipContent>
                        {resetMode === 'full-erase' ? 'Erase all data on the next device you pick' : 'Keep existing data'}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>

              {versionedDevices.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {connected ? 'No devices available for this OS.' : 'Connecting to relay…'}
                </p>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-2">
                  {versionedDevices.map((d: DeviceSummary) => {
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
                        onClick={() => handleStartDevice(d)}
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
                <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-2">
                  {agentGroups.map((s: SessionInfo) => {
                    const res = s.resources
                    const isStale = res ? Date.now() - res.reportedAt > 30_000 : false // eslint-disable-line react-hooks/purity
                    const deviceCount = s.devices.filter((d) => d.platform === os).length
                    const cpuPercent = res?.cpuPercent ?? 0
                    const memPercent = res ? (res.memUsedMB / res.memTotalMB) * 100 : 0
                    const health = getResourceHealth(res, isStale)
                    const isOverloaded = health === 'overloaded'
                    return (
                      <TooltipProvider key={s.agentName}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              tabIndex={isOverloaded ? 0 : undefined}
                              className={isOverloaded ? 'cursor-not-allowed' : undefined}
                            >
                              <button
                                disabled={isOverloaded}
                                aria-disabled={isOverloaded}
                                onClick={() => setSelectedAgent(s.agentName ?? null)}
                                className={cn(
                                  'flex flex-col gap-3 rounded-lg border p-3 text-left transition-colors min-h-[100px] w-full',
                                  isOverloaded ? 'pointer-events-none' : 'hover:bg-accent',
                                )}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <ResourceHealthDot health={health} />
                                    <span className="text-sm font-medium leading-tight truncate">
                                      {s.agentName ?? 'Unknown'}
                                    </span>
                                  </div>
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
                            </span>
                          </TooltipTrigger>
                          {isOverloaded && (
                            <TooltipContent>This Mac is currently overloaded. Try again later.</TooltipContent>
                          )}
                        </Tooltip>
                      </TooltipProvider>
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
          <Separator orientation="vertical" className="w-full h-px lg:h-auto lg:w-px" />
          <div className="w-full h-80 lg:w-80 lg:h-full shrink-0">
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

function ResourceHealthDot({ health }: { health: ResourceHealth }) {
  const colorClass = {
    unknown: 'bg-muted-foreground/40',
    healthy: 'bg-emerald-400',
    warning: 'bg-amber-400',
    overloaded: 'bg-red-500',
  }[health]
  return <span data-testid="resource-health-dot" className={cn('inline-block h-2 w-2 shrink-0 rounded-full', colorClass)} />
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
