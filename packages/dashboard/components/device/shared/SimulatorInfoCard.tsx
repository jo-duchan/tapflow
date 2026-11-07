'use client';

import { useMemo, useState } from 'react';
import { ScanLine } from 'lucide-react';
import { cn } from '@/lib/utils';
import { performanceMode } from '@/lib/decoders/pickDecoder';
import { PerformanceModeNotice } from '@/components/perf/PerformanceModeNotice';
import { shouldAutoShowPerfNotice, PERF_NOTICE_KEY } from '@/lib/perfNotice';
import type { BootRefusalReason } from '@tapflowio/protocol';

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
  /** The relay is holding this boot, and why (`device:boot-waiting`): another device on the same Mac has not
   *  settled, or the Mac is critically short of memory. */
  bootWaiting?: BootRefusalReason | null;
  /** An automated run started this device with most background services off (`slim`), and it is still that way. */
  servicesOff?: boolean;
  installing: boolean;
  installError: string | null;
  /** H.264 decode path is unavailable in this browser — the viewer can render the device chrome but
   *  no stream (#748). Routed through this shared status region so Android and iOS converge on the
   *  same one-sentence English copy instead of each viewer shipping its own overlay. */
  decoderUnsupported: boolean;
  keyboardActive: boolean;
  /** The relay is holding this session open while its agent is gone (#426). Outranks every other
   *  status: the rest describe a device this viewer cannot currently reach. */
  agentAway?: boolean;
  /** A fact about this session that does not change, shown under the status. Outside the live region:
   *  it is not a transition, and announcing it would only repeat what is on screen. */
  note?: string;
  /** Flow Capture (#1125): whether the relay is keeping this person's steps, by their own setting. A state only —
   *  the setting is changed in the account menu. Absent shows no chip, for a relay that predates it. */
  capturingSteps?: boolean;
}

/** One cell of the card's grid. Figma `tapflow-product` 284:2 (287:611). */
const CHIP = 'flex min-w-0 items-center gap-1.5 rounded bg-muted px-2.5 py-[5px] text-[11px] leading-[18px] text-muted-foreground';

function getStatusText(props: SimulatorInfoCardProps): string | null {
  const { connected, joined, bootError, bootWaiting, deviceReady, installing, installError, agentAway, decoderUnsupported } = props;
  if (!connected) return 'Connecting…';
  if (!joined) return 'Joining session…';
  if (agentAway) return 'The agent went away — waiting for it to come back…';
  if (bootError)
    return `Boot failed: ${bootError.length > 40 ? bootError.slice(0, 40) + '…' : bootError}`;
  if (!deviceReady && bootWaiting === 'host-memory-critical') return 'This Mac is low on memory. Yours starts when it frees up…';
  if (!deviceReady && bootWaiting) return 'Another device is starting on this Mac. Yours starts next…';
  if (!deviceReady) return 'Starting device…';
  if (installing) return 'Installing app…';
  if (installError) return `Install failed: ${installError}`;
  if (decoderUnsupported) return 'Streaming is not supported in this environment.';
  return null;
}

export function SimulatorInfoCard(props: SimulatorInfoCardProps) {
  const { joined, fps, keyboardActive } = props;
  const statusText = getStatusText(props);
  // fps is intentionally low when screen is static (idle keep-alive ~10fps).
  // Use "active/idle" framing instead of red/green to avoid false alarm.
  const isActive = fps > 15;
  // fps 0 (fully static screen / between frames) is still idle, not a blank state — keep the "Idle"
  // label instead of hiding it.
  const stateLabel = isActive ? 'Active' : 'Idle';
  // Decode path is a stable per-browser capability; compute once, not per device card.
  const mode = useMemo(() => performanceMode(), []);
  const modeLabel = MODE_LABEL[mode];
  // Read once, as the initial state: the notice either opens with the card or not at all.
  const [noticeOpen, setNoticeOpen] = useState(() => {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(PERF_NOTICE_KEY) === '1';
    } catch {
      /* no storage */
    }
    return shouldAutoShowPerfNotice(mode, dismissed);
  });
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
    <div className="w-[300px] shrink-0 mt-3 rounded-xl border bg-background p-3.5 flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2.5">
        {/* The state is a word, not only the colour (#747, WCAG 1.4.1): emerald against grey was the whole
            difference, which anyone who cannot separate those two colours, or who hears the card, could not
            read. */}
        <div className={cn(CHIP, keyboardActive && 'text-emerald-500')}>
          <ScanLine className="h-3.5 w-3.5 shrink-0" />
          <span>Focus</span>
          {/* Styled like the fps cell's `· Active` / `· Idle`, so the card has one look for a state word. */}
          <span aria-hidden="true" className="text-muted-foreground/60">·</span>
          <span className={keyboardActive ? 'text-emerald-500' : 'text-muted-foreground/60'}>{keyboardActive ? 'On' : 'Off'}</span>
        </div>
        {props.capturingSteps !== undefined && (
          // A different look from the screen recording's red dot on purpose: this records steps, not video.
          <div className={CHIP}>
            <span
              aria-hidden="true"
              className={cn('h-2 w-2 shrink-0 rounded-full', props.capturingSteps ? 'bg-amber-400' : 'bg-muted-foreground/40')}
            />
            <span className="truncate">{props.capturingSteps ? 'Capturing steps' : 'Not capturing steps'}</span>
          </div>
        )}

        {joined && (
          <div className={cn(CHIP, 'gap-1')}>
            <span className="font-mono text-foreground/75">{fps}</span>
            <span>fps</span>
            <span aria-hidden="true" className="text-muted-foreground/60">·</span>
            <span className={isActive ? 'text-emerald-500' : 'text-muted-foreground/60'}>{stateLabel}</span>
          </div>
        )}
        {joined && modeLabel && (
          <div className={CHIP}>
            {mode === 'standard' ? (
              <button
                type="button"
                onClick={() => setNoticeOpen(true)}
                className="text-foreground/70 hover:text-foreground underline-offset-2 hover:underline"
              >
                {modeLabel}
              </button>
            ) : (
              <span>{modeLabel}</span>
            )}
          </div>
        )}
      </div>

      {/* **The region is always mounted and the sentence arrives inside it**, which is the shape a
          live region has to have. This sentence is the only thing that says what a boot is doing, and
          after #628 a keyboard user is parked beside it for a whole restart.
          `role="status"` on the `<p>` itself does not work: that element is conditional, so the region
          and its first sentence land in the same commit with nothing to compare against — "Starting
          device…" and "Boot failed…" are exactly the transitions that go missing. Mounting the `<p>`
          unconditionally instead adds a line's height to every card with nothing to say, and a second
          sr-only copy of the text puts the same sentence in the tree twice. An empty wrapper costs
          neither. */}
      {/* `sr-only` while empty, which is `position: absolute` — so it stops being a flex item and stops
          consuming one of the parent's `gap-3`. The normal state of this card is *no* sentence at all
          (connected, joined, ready, installed), and that is where a permanently mounted 0-height child
          would still have added 12px. The node is the same one either way, which is the whole point of
          mounting it early. */}
      <div role="status" className={statusText ? undefined : 'sr-only'}>
      {statusText && (
        <p className="rounded bg-muted px-2.5 py-[5px] text-[12px] text-muted-foreground leading-relaxed break-words">{statusText}</p>
      )}
      </div>

      {props.servicesOff && (
        <p className="text-[12px] text-muted-foreground leading-relaxed break-words">
          An automated run started this device with most background services off, apart from any it asked to keep. Restart the device to turn them back on.
        </p>
      )}
      {props.note && (
        <p className="text-[12px] text-muted-foreground leading-relaxed break-words">{props.note}</p>
      )}

      <PerformanceModeNotice open={noticeOpen} onOpenChange={handleNoticeOpenChange} />
    </div>
  );
}
