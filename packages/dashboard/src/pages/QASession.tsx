import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queries';
import { toast } from 'sonner';
import type { SessionTerminatedReason } from '@tapflowio/protocol';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useBreadcrumb } from '@/hooks/useBreadcrumb';
import { useBuildLoader } from '@/hooks/useBuildLoader';
import { useAgentSession } from '@/hooks/useAgentSession';
import { useDeviceSelector } from '@/hooks/useDeviceSelector';
import { useAuth } from '@/hooks/useAuth';
import { DeviceCardActions } from '@/components/device/DeviceCardActions';
import { shownName } from '@/lib/deviceGroups';
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
import { PLATFORM_LABEL, STATUS_TONE, buildLabel } from '@/lib/build-format';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { SearchInput } from '@/components/ui/search-input';
import type { DeviceSummary, SessionInfo } from '@/lib/types';
import { holderKindLabel } from '@/lib/aiSession';
import { getResourceHealth, RESOURCE_STALE_MS, type ResourceHealth } from '@/lib/resource-health';
import { announceEndedSessions, classifyResume, interruptedSessions, minutesLeft, type ResumeStep, type ResumeTarget } from '@/lib/resumeEntry';
import {
  InterruptedSessionsBanner, ResumeWaitBanner, RestartDialog, TakeOverDialog, type InterruptedSession,
} from '@/components/session-resume/SessionResumeNotices';

/** Why this viewer stopped — a superset of the relay's termination reasons; see `DeviceViewer`'s prop. */
type ViewerStoppedReason = SessionTerminatedReason | 'busy-elsewhere' | 'mac-overloaded';

// Keyed by the reason so a new one cannot be added without deciding what the user is told. A
// callback that ignored `reason` would keep showing "the agent disconnected" for every future
// cause — which is exactly what the literal union exists to prevent.
const sayEnded = (by: string, deviceName: string) =>
  toast.info(`${by} is using ${deviceName} now.`, { description: 'Your session on it ended while you were away.' });

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

/**
 * Keyed by build, so a link into another build's session (#1087) mounts the page again and is read as a URL entry:
 * the URL is read once, at mount. Its own `session`/`device` writes do not change the key.
 */
export function QASession() {
  const [searchParams] = useSearchParams();
  return <QASessionPage key={searchParams.get('id') ?? ''} />;
}

function QASessionPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const buildId = searchParams.get('id');
  // A session URL (#1087), read once: when this page mounts. The URL this page writes for a device it starts must
  // not send it back through here, or it would re-decide the session the tester is in. `since` is set by the first
  // listing, because a render cannot read the clock.
  const [resumeTarget, setResumeTarget] = useState<ResumeTarget | null>(() => {
    const sessionId = searchParams.get('session');
    const deviceId = searchParams.get('device');
    return sessionId && deviceId ? { sessionId, deviceId, since: -1 } : null;
  });
  const [waitStep, setWaitStep] = useState<Extract<ResumeStep, { kind: 'wait' }> | null>(null);
  const [restartFor, setRestartFor] = useState<DeviceSummary | null>(null);
  const [takeOver, setTakeOver] = useState<DeviceSummary | null>(null);
  const takeOverCardRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const onListedRef = useRef<(sessions: SessionInfo[]) => void>(() => {});

  const { build } = useBuildLoader(buildId);
  const queryClient = useQueryClient();

  const os = build?.platform ?? 'ios';
  const {
    sessions, activeFormFactor, selectedAgent, setSelectedAgent,
    activeSessionId, deviceId, booting, status,
    connected, agentGroups,
    startDevice, resetDevice, handleBack, handleBackToMacs, handleSessionEnded,
    resumed, send,
  } = useAgentSession(os, (listed) => onListedRef.current(listed));

  const selectedSession = agentGroups.find((s) => s.agentName === selectedAgent);
  const isAdmin = useAuth().user?.role === 'Admin';
  const {
    osVersions, osVersion, setOsVersion,
    deviceSearch, setDeviceSearch, versionedDevices, deviceGroups, hiddenCount, showHidden, setShowHidden,
    resetMode, setResetMode, appliedResetMode, consumeResetMode, fullResetSupported,
  } = useDeviceSelector(selectedSession, os, isAdmin);

  const allDevices = sessions.flatMap((s) => s.devices);
  const selectedDevice = allDevices.find((d) => d.id === deviceId);
  const deviceLabel = selectedDevice
    ? `${shownName(selectedDevice)}${selectedDevice.osVersion ? ` · ${selectedDevice.osVersion}` : ''}`
    : '';

  // The list under the viewer reads the recordings query; an upload makes it stale.
  const handleRecordingUploaded = useCallback(() => { void queryClient.invalidateQueries({ queryKey: queryKeys.allRecordings }); }, [queryClient]);

  // Full reset is a one-shot instruction, not a setting. Snapshot it for this launch and turn the
  // toggle off in the same click: the value has to survive because `device:boot` is only sent later,
  // after `session:joined` arrives, and clearing the toggle alone would leave `app-only` in its place.
  // Turning it off here is also what stops the next device from being erased too (#439).
  //
  // Consumed on click, not on success — a failed boot does not re-arm it. Asking again means
  // turning it on again, which keeps an irreversible action tied to an explicit act.
  const clearSessionUrl = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('session');
      next.delete('device');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const stopResuming = useCallback(() => { setResumeTarget(null); setWaitStep(null); }, []);

  // `replace`, so Back in the browser leaves the page rather than stepping through the devices tried.
  const beginDevice = useCallback((d: DeviceSummary, resume: boolean) => {
    // A reset is for a fresh start. A resume keeps what is there — that is what the tester came back for.
    if (!resume) consumeResetMode();
    startDevice(d, { resume });
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('session', d.sessionId);
      next.set('device', d.id);
      return next;
    }, { replace: true });
  }, [consumeResetMode, startDevice, setSearchParams]);

  const handleStartDevice = useCallback((d: DeviceSummary) => {
    stopResuming();
    beginDevice(d, false);
  }, [stopResuming, beginDevice]);

  const leaveDevice = useCallback(() => { handleBack(); clearSessionUrl(); stopResuming(); }, [handleBack, clearSessionUrl, stopResuming]);
  const leaveMac = useCallback(() => { handleBackToMacs(); clearSessionUrl(); stopResuming(); }, [handleBackToMacs, clearSessionUrl, stopResuming]);

  // Read in the listing handler rather than in an effect over `sessions`: what follows from a listing is a reaction to
  // that message, and it sets state.
  useLayoutEffect(() => {
    onListedRef.current = (listed) => {
      announceEndedSessions(listed, sayEnded);
      if (!resumeTarget || activeSessionId || !build) return;
      const now = Date.now();
      const target = resumeTarget.since < 0 ? { ...resumeTarget, since: now } : resumeTarget;
      const step = classifyResume(listed, target, now);
      if (step.kind === 'wait') {
        setResumeTarget(step.why === 'own-tab' && target.ownTabSince === undefined ? { ...target, ownTabSince: now } : target);
        if (step.agentName) setSelectedAgent(step.agentName);
        setWaitStep(step);
        return;
      }
      stopResuming();
      if (step.kind === 'join') {
        setSelectedAgent(step.agentName);
        beginDevice(step.device, true);
        return;
      }
      clearSessionUrl();
      if (step.kind === 'gone') {
        toast.error('That device is not available any more.', { description: 'Pick a device to start a new session.' });
        return;
      }
      setSelectedAgent(step.agentName);
      if (step.kind === 'restart') setRestartFor(step.device);
      // Taken: the notice above already said by whom. Someone else's waiting session: its card says so.
      if (step.kind === 'in-use') {
        if (step.self) toast.error('That session is still open in another of your tabs.', { description: 'Close that tab, or carry on there.' });
        else toast.error('Someone else is using that device now.', { description: 'Pick another device, or wait for it to be free.' });
      }
    };
  });

  // A URL entry waits for a listing read after the build is known, so ask for one then instead of waiting out the poll.
  const resuming = resumeTarget !== null;
  useEffect(() => {
    if (build && resuming && connected) send({ type: 'agents:list' });
  }, [build, resuming, connected, send]);

  // Where focus goes when a notice above the list removes itself: the list's first control, never `body`. Not a control
  // in the notices, which are the thing going away.
  const focusList = useCallback(() => {
    const controls = listRef.current?.querySelectorAll<HTMLElement>('input, button:not([disabled])') ?? [];
    const first = searchRef.current ?? [...controls].find((el) => !el.closest('[data-resume-notices]'));
    first?.focus();
  }, []);

  const interrupted: InterruptedSession[] = interruptedSessions(sessions, os);
  const resumeInterrupted = useCallback((s: InterruptedSession) => {
    const buildOfSession = s.device.waiting?.buildId;
    // Another build's session is resumed on that build's page, where its app is what gets kept. With no build on
    // record the relay does not count the app as installed, so this page's build goes on, as from the device's card.
    if (buildOfSession !== undefined && buildOfSession !== build?.id) {
      navigate(`/app-center/build?${new URLSearchParams({ id: String(buildOfSession), session: s.device.sessionId, device: s.device.id })}`);
      return;
    }
    stopResuming();
    setSelectedAgent(s.agentName);
    beginDevice(s.device, true);
  }, [build, navigate, stopResuming, setSelectedAgent, beginDevice]);
  const endInterrupted = useCallback((s: InterruptedSession) => {
    send({ type: 'device:shutdown', sessionId: s.device.sessionId, payload: { deviceId: s.device.id } });
    send({ type: 'agents:list' });
    // The row goes with the next listing; move focus off it now.
    focusList();
  }, [send, focusList]);

  // The viewer cannot make progress — the agent went away, or another socket holds the session. Say
  // which, and go back to the Mac list. Before #426 the tab just sat on "Waiting for first frame..."
  // with no way to know a refresh was needed; `busy-elsewhere` sat on it just as silently until L6.
  const onSessionEnded = useCallback((reason: ViewerStoppedReason) => {
    // A resume that met the session still held: not an end, the wait the URL entry would have shown. Back to the list
    // with the session as the target again, read as held by another of this tester's tabs.
    if (reason === 'busy-elsewhere' && resumed && activeSessionId) {
      const now = Date.now();
      handleSessionEnded();
      setResumeTarget({ sessionId: activeSessionId, deviceId, since: now, ownTabSince: now });
      return;
    }
    const notice = SESSION_ENDED_NOTICE[reason];
    toast.error(notice.title, { description: notice.description });
    handleSessionEnded();
    clearSessionUrl();
  }, [handleSessionEnded, clearSessionUrl, resumed, activeSessionId, deviceId]);

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
                  <button onClick={leaveMac}>{buildLabel(build)}</button>
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
                      <button onClick={leaveDevice}>{selectedAgent}</button>
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
  }, [build, selectedAgent, activeSessionId, deviceLabel, navigate, leaveDevice, leaveMac, setBreadcrumb]);

  return (
    <div className="flex h-full min-h-0 gap-6 p-6">
      <div className="flex flex-col gap-3 flex-1 min-w-0 min-h-0">
        {/* -ml-1 pl-1: 좌측 ring 클리핑 방지 / -mr-4 pr-4: 스크롤바 마진 영역으로 분리 */}
        <div ref={listRef} className="flex-1 min-h-0 overflow-auto -ml-1 pl-1 -mr-4 pr-4">
          {!activeSessionId && (waitStep || interrupted.length > 0) && (
            <div data-resume-notices className="flex flex-col gap-2 pb-5">
              {waitStep && (
                <ResumeWaitBanner
                  why={waitStep.why}
                  deviceName={waitStep.device?.name}
                  // Flushed first: the banner holding this button is gone after it, and focus must not go with it.
                  onCancel={() => { flushSync(() => { stopResuming(); clearSessionUrl(); }); focusList(); }}
                />
              )}
              {!waitStep && (
                <InterruptedSessionsBanner
                  sessions={interrupted}
                  onResume={resumeInterrupted}
                  onEnd={endInterrupted}
                />
              )}
            </div>
          )}
          {activeSessionId ? (
            <div className="min-h-full flex items-center justify-center py-6 px-8 min-w-max">
              <DeviceViewer
                // Keyed, so a different session is a different mount: the viewer's per-mount records (the reset already
                // sent, the installs kept) belong to one session.
                key={activeSessionId}
                sessionId={activeSessionId}
                deviceId={deviceId}
                formFactor={selectedDevice?.formFactor ?? activeFormFactor}
                platform={os}
                buildId={build?.id}
                resume={resumed}
                resetMode={resumed ? 'app-only' : appliedResetMode}
                onRecordingUploaded={handleRecordingUploaded}
                onSessionEnded={onSessionEnded}
              />
            </div>
          ) : selectedAgent ? (
            <div className="flex flex-col gap-5">
              {/* No back button here: the breadcrumb's build entry returns to the Macs, as every other page goes
                  back through the breadcrumb. */}
              <h1 className="text-xl font-semibold tracking-tight">Select device</h1>

              <div className="flex items-center gap-2">
                <SearchInput
                  ref={searchRef}
                  aria-label="Search devices"
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
                    <SelectTrigger className="h-8 w-36 shrink-0" aria-label="Filter by OS version">
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
                {/* Only an Admin can hide a device, so only an Admin is offered them back (#1085). */}
                {isAdmin && hiddenCount > 0 && (
                  <div className="flex items-center gap-2 shrink-0">
                    <Switch id="show-hidden" checked={showHidden} onCheckedChange={setShowHidden} />
                    <Label htmlFor="show-hidden" className="text-sm cursor-pointer whitespace-nowrap">
                      Show hidden ({hiddenCount})
                    </Label>
                  </div>
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
                // One grid for every group, headings included, so a card starred into Favourites moves within the
                // same parent rather than remounting, and keeps the focus its star had (#1085).
                <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-2">
                  {deviceGroups.flatMap((group, groupIndex) => [
                    ...(group.title ? [
                      <h2 key={`heading:${group.key}`}
                        className={cn('col-span-full text-sm font-medium text-muted-foreground', groupIndex > 0 && 'mt-3')}>
                        {group.title}
                      </h2>,
                    ] : []),
                    ...group.devices.map((d: DeviceSummary) => {
                    const isBooted = d.status === 'booted'
                    const isBusy = d.busy
                    // On a Mac short of memory the relay lets a person rejoin only a device it brought up itself; the
                    // listing names the rest. Not `!isBooted`: a simulator running before its agent registered reads
                    // booted and is still refused.
                    const needsMemory = selectedSession?.admission.memoryRefuses.includes(d.id) ?? false
                    // **Says who is driving an AI-held device, and offers no way in.** Watching an AI session
                    // is for the person who started it, through the link their coding agent hands them; the
                    // device list only explains why the device is taken.
                    // A dropped session waiting for its owner (#1087). The tester's own resumes it; someone else's asks first.
                    const yours = d.waiting?.yours === true
                    const othersWait = d.waiting && !yours ? d.waiting : null
                    const statusLabel = isBusy
                      ? (d.holder ? `${holderKindLabel(d.holder.kind)} is driving it` : 'In use')
                      : yours ? 'Your session is waiting for you'
                      : othersWait ? `Waiting for ${othersWait.name} to return${othersWait.remainingMs !== undefined ? ` · about ${minutesLeft(othersWait.remainingMs)} min` : ''}`
                      : needsMemory ? 'Not enough memory to start' : isBooted ? 'Booted' : 'Available'
                    const statusDot = isBusy || d.waiting
                      ? 'bg-amber-400'
                      : isBooted
                        ? 'bg-emerald-400'
                        : 'bg-muted-foreground/40'
                    const cardDisabled = isBusy || needsMemory || booting || !connected
                    const card = (
                      <button
                        disabled={cardDisabled}
                        onClick={(e) => {
                          if (yours && d.resumable) {
                            stopResuming();
                            beginDevice(d, true);
                          } else if (othersWait) {
                            takeOverCardRef.current = e.currentTarget;
                            setTakeOver(d);
                          } else handleStartDevice(d);
                        }}
                        className={cn(
                          // 105px: the height a card reaches with the Hidden badge on its status line, so a hidden card does not
                          // stretch its row (#1085).
                          'flex h-full w-full flex-col gap-3 rounded-lg border p-3 pr-20 text-left transition-colors min-h-[105px]',
                          'hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
                          d.hidden && 'border-dashed',
                        )}
                      >
                        <span className="flex flex-col gap-0.5">
                          <span className="text-sm font-medium leading-tight">{shownName(d)}</span>
                          {/* The device's own name, which is what automation and the logs call it. */}
                          {d.displayName && <span className="text-xs text-muted-foreground">{d.name}</span>}
                        </span>
                        {d.osVersion && (
                          <span className="font-mono text-xs text-muted-foreground">{d.osVersion}</span>
                        )}
                        {/* Hidden is a state of the device, so it sits on the status line rather than on a line of its own.
                            The line is always the badge's height (15px text, 2px padding and 1px border each side), so the
                            status does not shift between a hidden card and the one beside it. */}
                        <span className="flex min-h-[21px] items-center gap-3">
                          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <span className={cn('inline-block h-1.5 w-1.5 rounded-full', statusDot)} />
                            {statusLabel}
                          </span>
                          {d.hidden && <Badge variant="outline" className="text-[10px] leading-[15px]">Hidden</Badge>}
                        </span>
                        {/* A run's `--service-tier slim` survives until the device restarts; say so before it is picked. */}
                        {isBooted && typeof d.serviceTier === 'object' && d.serviceTier.name === 'slim' && (
                          <span className="text-[10px] text-muted-foreground">Most services off</span>
                        )}
                      </button>
                    )
                    // The card names the person; who exactly, by email, is on hover and focus. A disabled button gets
                    // neither, and its label then says who is driving it rather than whom it waits for.
                    return (
                      <div key={d.id} className="relative">
                        {!othersWait || cardDisabled ? card : (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>{card}</TooltipTrigger>
                              <TooltipContent>{othersWait.user}</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                        <DeviceCardActions device={d} agentKey={selectedSession?.agentKey} isAdmin={isAdmin}
                          refresh={() => send({ type: 'agents:list' })} hidingLeaves={!showHidden} onLeaving={focusList} />
                      </div>
                    )
                  }),
                  ])}
                </div>
              )}

              {status && <p className="text-sm text-muted-foreground">{status}</p>}
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <h1 className="text-xl font-semibold tracking-tight">Select Mac</h1>

              {agentGroups.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {connected ? `No agents available for ${PLATFORM_LABEL[os]}.` : 'Connecting to relay…'}
                </p>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-2">
                  {agentGroups.map((s: SessionInfo) => {
                    const res = s.resources
                    const isStale = res ? Date.now() - res.reportedAt > RESOURCE_STALE_MS : false // eslint-disable-line react-hooks/purity
                    const deviceCount = s.devices.filter((d) => d.platform === os).length
                    const cpuPercent = res?.cpuPercent ?? 0
                    const memPercent = res ? (res.memUsedMB / res.memTotalMB) * 100 : 0
                    // The dot and bars show the readings; whether the Mac takes a new session is the relay's call, which
                    // pauses its CPU check while a device is booting there — a threshold recomputed here would block a
                    // Mac the relay lets in.
                    const health = getResourceHealth(res, isStale)
                    const isOverloaded = s.admission.overloaded
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
                                  {isStale ? (
                                    <span className="shrink-0 text-[10px] font-medium text-amber-500">Stale</span>
                                  ) : s.admission.booting && (
                                    <span className="shrink-0 text-[10px] font-medium text-muted-foreground">Starting a device</span>
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

      <TakeOverDialog
        device={takeOver}
        onCancel={() => setTakeOver(null)}
        onConfirm={(d) => { setTakeOver(null); handleStartDevice(d); }}
        returnFocusTo={takeOverCardRef}
      />
      <RestartDialog
        device={restartFor}
        onClose={() => setRestartFor(null)}
        onStart={(d) => { setRestartFor(null); handleStartDevice(d); }}
        returnFocusTo={searchRef}
      />

      {buildId && (
        <>
          <Separator orientation="vertical" className="h-auto" />
          <div className="w-80 shrink-0 h-full">
            <SessionPanel
              buildId={Number(buildId)}
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
