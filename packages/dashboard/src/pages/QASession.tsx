import { useCallback, useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useRelay } from '@/hooks/useRelay';
import { SimulatorViewer } from '@/components/SimulatorViewer';
import { CommentPanel } from '@/components/comment-panel';
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
import type { AgentDevice, RelayMessage, SessionInfo } from '@/lib/types';

type Build = {
  id: number;
  name: string;
  version_label: string | null;
  status_label: string | null;
  platform: string;
};

export function QASession() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const buildId = searchParams.get('id');

  const [build, setBuild] = useState<Build | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [os, setOs] = useState<string>('ios');
  const [deviceId, setDeviceId] = useState<string>('');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [booting, setBooting] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!buildId) return;
    fetch(`/api/v1/builds/${buildId}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then(setBuild);
  }, [buildId]);

  const handleMessage = useCallback(
    (msg: RelayMessage) => {
      if (msg.type === 'agents:listed') {
        setSessions(msg.sessions);
        if (!deviceId && msg.sessions.length > 0) {
          const first = msg.sessions[0].devices[0];
          if (first) {
            setOs(first.platform);
            setDeviceId(first.id);
          }
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

  const allDevices = sessions.flatMap((s) => s.devices);
  const filteredDevices = allDevices.filter((d) => d.platform === os);

  const osVersions = [
    ...new Set(filteredDevices.map((d) => d.osVersion).filter(Boolean)),
  ] as string[];
  const [osVersion, setOsVersion] = useState<string>('');

  const versionedDevices = osVersion
    ? filteredDevices.filter((d) => d.osVersion === osVersion)
    : filteredDevices;

  const selectedDevice = allDevices.find((d) => d.id === deviceId);

  function handleBoot() {
    if (!selectedDevice || !deviceId) return;
    setBooting(true);
    setStatus('Booting…');
    send({ type: 'session:start', sessionId: selectedDevice.sessionId, deviceId });
    setActiveSessionId(selectedDevice.sessionId);
  }

  function handleBack() {
    if (activeSessionId && deviceId) {
      send({ type: 'device:shutdown', sessionId: activeSessionId, payload: { deviceId } });
    }
    setActiveSessionId(null);
  }

  return (
    <div className="flex h-full gap-6">
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
            />
          </>
        ) : (
          <div className="flex flex-col gap-6 max-w-lg">
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

            <div className="flex flex-col gap-4">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Select device
              </h2>

              <div className="flex flex-col gap-3">
                <div className="grid gap-1.5">
                  <span className="text-sm font-medium">OS</span>
                  <Select
                    value={os}
                    onValueChange={(v) => {
                      setOs(v);
                      setDeviceId('');
                      setOsVersion('');
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ios">iOS</SelectItem>
                      <SelectItem value="android">Android</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {osVersions.length > 0 && (
                  <div className="grid gap-1.5">
                    <span className="text-sm font-medium">OS version</span>
                    <Select
                      value={osVersion || '__all__'}
                      onValueChange={(v) => {
                        setOsVersion(v === '__all__' ? '' : v);
                        setDeviceId('');
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__all__">Any version</SelectItem>
                        {osVersions.map((v) => (
                          <SelectItem key={v} value={v}>
                            {v}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="grid gap-1.5">
                  <span className="text-sm font-medium">Device</span>
                  {versionedDevices.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {connected ? 'No devices available for this OS.' : 'Connecting to relay…'}
                    </p>
                  ) : (
                    <Select value={deviceId} onValueChange={setDeviceId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a device" />
                      </SelectTrigger>
                      <SelectContent>
                        {versionedDevices.map((d: AgentDevice) => (
                          <SelectItem key={d.id} value={d.id}>
                            {d.name}
                            {d.status === 'booted' && (
                              <span className="ml-1 text-xs text-muted-foreground">(booted)</span>
                            )}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </div>

              {status && <p className="text-sm text-muted-foreground">{status}</p>}

              <Button
                onClick={handleBoot}
                disabled={!deviceId || booting || !connected}
                className="w-full"
              >
                {booting
                  ? 'Booting…'
                  : selectedDevice?.status === 'booted'
                    ? 'Connect'
                    : 'Boot & Connect'}
              </Button>
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
