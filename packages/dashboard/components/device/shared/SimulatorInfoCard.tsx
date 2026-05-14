'use client';

import { ScanLine } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SimulatorInfoCardProps {
  joined: boolean;
  fps: number;
  connected: boolean;
  deviceReady: boolean;
  bootError: string | null;
  installing: boolean;
  installError: string | null;
  keyboardActive: boolean;
}

function getStatusText(props: SimulatorInfoCardProps): string | null {
  const { connected, joined, bootError, deviceReady, installing, installError } = props;
  if (!connected) return 'Connecting…';
  if (!joined) return 'Joining session…';
  if (bootError) return `Boot failed: ${bootError.length > 40 ? bootError.slice(0, 40) + '…' : bootError}`;
  if (!deviceReady) return 'Starting device…';
  if (installing) return 'Installing app…';
  if (installError) return `Install failed: ${installError}`;
  return null;
}

export function SimulatorInfoCard(props: SimulatorInfoCardProps) {
  const { joined, fps, keyboardActive } = props;
  const statusText = getStatusText(props);
  // fps is intentionally low when screen is static (idle keep-alive ~10fps).
  // Use "active/idle" framing instead of red/green to avoid false alarm.
  const isActive = fps > 15;
  const isIdle = fps > 0 && fps <= 15;
  const dotColor = isActive ? '#10b981' : isIdle ? '#94a3b8' : 'transparent';
  const stateLabel = isActive ? 'Active' : isIdle ? 'Idle' : null;

  return (
    <div className="w-[300px] shrink-0 mt-3 rounded-xl border bg-background px-4 py-4 flex flex-col gap-3">
      <div className={cn('flex items-center', keyboardActive ? 'text-emerald-500' : 'text-muted-foreground')} style={{ gap: 6 }}>
        <ScanLine className="h-3.5 w-3.5 shrink-0" />
        <span className="text-[12px] font-medium">Focus</span>
      </div>

      {joined && fps > 0 && (
        <div className="flex items-center" style={{ gap: 6 }}>
          <span className="h-2 w-2 rounded-full shrink-0" style={{ background: dotColor }} />
          <span className="text-[12px] font-mono text-foreground/75">{fps}</span>
          <span className="text-[12px] text-muted-foreground">fps</span>
          {stateLabel && (
            <span className={cn('text-[11px]', isActive ? 'text-emerald-500' : 'text-muted-foreground/60')}>
              · {stateLabel}
            </span>
          )}
        </div>
      )}

      {statusText && (
        <p className="text-[12px] text-muted-foreground leading-relaxed">{statusText}</p>
      )}
    </div>
  );
}
