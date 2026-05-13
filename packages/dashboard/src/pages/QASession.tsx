import { useCallback, useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useRelay } from '@/hooks/useRelay';
import { SimulatorViewer } from '@/components/SimulatorViewer';
import { CommentPanel } from '@/components/comment-panel';
import { RecordingsList } from '@/components/RecordingsList';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ArrowLeft } from 'lucide-react';
import { getBuild } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { SearchInput } from '@/components/ui/search-input';
import type { AgentDevice, Build, RelayMessage, SessionInfo } from '@/lib/types';

export function QASession() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const buildId = searchParams.get('id');

  const [build, setBuild] = useState<Build | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [booting, setBooting] = useState(false);
  const [status, setStatus] = useState('');
  const [recordingsKey, setRecordingsKey] = useState(0);

  useEffect(() => {
    if (!buildId) return;
    getBuild(buildId).then(setBuild);
  }, [buildId]);

  const handleMessage = useCallback(
    (msg: RelayMessage) => {
      if (msg.type === 'agents:listed') {
        setSessions(msg.sessions);
        if (!deviceId && msg.sessions.length > 0) {
          const first = msg.sessions[0].devices[0];
          if (first) setDeviceId(first.id);
        }
      }
      if (msg.type === 'session:joined') {
        setBooting(false);
        setStatus('Connected');
      }
      if (msg.type === 'error') {
        setBooting(false);
        setStatus(`Error: ${msg.message}`);
      }
    },
    [deviceId],
  );

  const { send, connected } = useRelay(handleMessage);

  useEffect(() => {
    if (connected) send({ type: 'agents:list' });
  }, [connected, send]);

  const os = build?.platform ?? 'ios';
  const allDevices = sessions.flatMap((s) => s.devices);
  const filteredDevices = allDevices.filter((d) => d.platform === os);

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

  function handleBack() {
    if (activeSessionId && deviceId) {
      send({ type: 'device:shutdown', sessionId: activeSessionId, payload: { deviceId } });
    }
    setActiveSessionId(null);
    setBooting(false);
    setStatus('');
  }

  return (
    <div className="flex h-full gap-6 p-6">
      <div className="flex flex-col gap-3 flex-1 min-w-0">
        {activeSessionId ? (
          <>
            <div className="flex w-full items-center gap-3">
              <Button variant="ghost" size="sm" onClick={handleBack}>
                <ArrowLeft className="mr-1 h-4 w-4" />
                Back
              </Button>
              {build && (
                <span className="text-sm text-muted-foreground">
                  {build.name}
                  {build.version_label ? ` · ${build.version_label}` : ''}
                </span>
              )}
            </div>
            <SimulatorViewer
              sessionId={activeSessionId}
              deviceId={deviceId}
              onBack={handleBack}
              buildId={build?.id}
              onRecordingUploaded={() => setRecordingsKey((k) => k + 1)}
            />
            <RecordingsList sessionId={activeSessionId} refreshKey={recordingsKey} />
          </>
        ) : (
          <div className="flex flex-col gap-6">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
                <ArrowLeft className="mr-1 h-4 w-4" />
                Back
              </Button>
              {build && (
                <div className="flex items-center gap-2">
                  <span className="font-medium">{build.name}</span>
                  {build.version_label && <Badge variant="outline">{build.version_label}</Badge>}
                  {build.status_label && <Badge variant="secondary">{build.status_label}</Badge>}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-5">
              <h1 className="text-xl font-semibold tracking-tight">Select device</h1>

              <div className="flex gap-2">
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
                          'flex flex-col gap-3 rounded-lg border p-3 text-left transition-colors',
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
          </div>
        )}
      </div>

      {buildId && (
        <>
          <Separator orientation="vertical" className="h-auto" />
          <div className="w-80 shrink-0">
            <CommentPanel buildId={Number(buildId)} />
          </div>
        </>
      )}
    </div>
  );
}
