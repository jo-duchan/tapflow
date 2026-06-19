'use client';

import { useEffect, useMemo, useState } from 'react';
import { ScanLine } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Separator } from '@/components/ui/separator';
import { performanceMode } from '@/lib/decoders/pickDecoder';
import {
  PerformanceModeNotice,
  shouldAutoShowPerfNotice,
  PERF_NOTICE_KEY,
} from '@/components/perf/PerformanceModeNotice';

// init wizard와 같은 프로파일 용어로 — 디코더 jargon(WebCodecs/WASM) 대신.
const MODE_LABEL: Record<string, string | null> = {
  high: 'Smooth',
  standard: 'Standard',
  unsupported: null,
};

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
  if (bootError)
    return `Boot failed: ${bootError.length > 40 ? bootError.slice(0, 40) + '…' : bootError}`;
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
  // Decode path is a stable per-browser capability; compute once, not per device card.
  const mode = useMemo(() => performanceMode(), []);
  const modeLabel = MODE_LABEL[mode];
  const [noticeOpen, setNoticeOpen] = useState(false);
  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(PERF_NOTICE_KEY) === '1';
    } catch {
      /* no storage */
    }
    if (shouldAutoShowPerfNotice(mode, dismissed)) setNoticeOpen(true);
  }, [mode]);
  const handleNoticeOpenChange = (next: boolean) => {
    setNoticeOpen(next);
    if (!next) {
      try {
        localStorage.setItem(PERF_NOTICE_KEY, '1');
      } catch {
        /* no storage */
      }
    }
  };

  return (
    <div className="w-[300px] shrink-0 mt-3 rounded-xl border bg-background px-4 py-4 flex flex-col gap-3">
      <div
        className={cn(
          'flex items-center',
          keyboardActive ? 'text-emerald-500' : 'text-muted-foreground',
        )}
        style={{ gap: 6 }}
      >
        <ScanLine className="h-3.5 w-3.5 shrink-0" />
        <span className="text-[12px] font-medium">Focus</span>
      </div>

      {joined && (
        <div className="flex items-center gap-[12px]">
          <div className="flex items-center gap-[4px]">
            <span className="h-2 w-2 rounded-full shrink-0 mr-1" style={{ background: dotColor }} />
            <span className="text-[12px] font-mono text-foreground/75">{fps}</span>
            <span className="text-[12px] text-muted-foreground">fps</span>
            {stateLabel && <span className="text-[11px] text-muted-foreground/60">·</span>}
            {stateLabel && (
              <span
                className={cn(
                  'text-[11px]',
                  isActive ? 'text-emerald-500' : 'text-muted-foreground/60',
                )}
              >
                {stateLabel}
              </span>
            )}
          </div>
          {modeLabel && (
            <>
              <Separator orientation="vertical" className="h-3" />
              {mode === 'standard' ? (
                <button
                  type="button"
                  onClick={() => setNoticeOpen(true)}
                  className="text-[11px] text-foreground/70 hover:text-foreground underline-offset-2 hover:underline"
                >
                  {modeLabel}
                </button>
              ) : (
                <span className="text-[11px] text-muted-foreground">{modeLabel}</span>
              )}
            </>
          )}
        </div>
      )}

      {statusText && (
        <p className="text-[12px] text-muted-foreground leading-relaxed break-all">{statusText}</p>
      )}

      <PerformanceModeNotice open={noticeOpen} onOpenChange={handleNoticeOpenChange} />
    </div>
  );
}
