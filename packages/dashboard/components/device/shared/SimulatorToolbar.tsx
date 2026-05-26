'use client';

import { Camera, Link2, Loader2, RotateCw, Square, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { Kbd, KbdGroup } from '@/components/ui/kbd';

function ShortcutTooltip({ label, keys }: { label: string; keys: string[] }) {
  return (
    <span className="flex items-center gap-3">
      {label}
      <KbdGroup>
        {keys.map((k) => <Kbd key={k}>{k}</Kbd>)}
      </KbdGroup>
    </span>
  );
}

interface SimulatorToolbarProps {
  joined: boolean;
  onScreenshot: () => void;
  onRecordToggle: () => void;
  recordState: 'idle' | 'recording' | 'uploading' | 'done';
  onRotate: () => void;
  onDeepLink: () => void;
  /** Platform-specific buttons rendered at the top (e.g. nav buttons, home, keyboard) */
  platformSlot?: ReactNode;
  /** Optional launch button rendered before platform buttons */
  launchSlot?: ReactNode;
}

export function SimulatorToolbar({
  joined,
  onScreenshot,
  onRecordToggle,
  recordState,
  onRotate,
  onDeepLink,
  platformSlot,
  launchSlot,
}: SimulatorToolbarProps) {
  if (!joined) return null;

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex flex-col items-center gap-0.5 rounded-2xl border bg-background/90 backdrop-blur-sm px-1.5 py-2.5 shrink-0 mt-3">
        {launchSlot}
        {platformSlot}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onDeepLink}>
              <Link2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left"><ShortcutTooltip label="Deeplink" keys={['⌘', 'K']} /></TooltipContent>
        </Tooltip>

        <div className="w-4 h-px bg-border my-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onScreenshot}>
              <Camera className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left"><ShortcutTooltip label="Screenshot" keys={['⌘', 'S']} /></TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost" size="icon"
              className={cn('h-8 w-8', recordState === 'recording' && 'text-red-500 hover:text-red-500')}
              disabled={recordState === 'uploading' || recordState === 'done'}
              onClick={onRecordToggle}
            >
              {recordState === 'uploading'
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : recordState === 'recording'
                ? <Square className="h-4 w-4 fill-current" />
                : <Video className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">
            {recordState === 'idle'
              ? <ShortcutTooltip label="Start recording" keys={['⌘', '⇧', 'Y']} />
              : recordState === 'recording'
              ? <ShortcutTooltip label="Stop recording" keys={['⌘', '⇧', 'Y']} />
              : 'Processing…'}
          </TooltipContent>
        </Tooltip>

        <div className="w-4 h-px bg-border my-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onRotate}>
              <RotateCw className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left"><ShortcutTooltip label="Rotate" keys={['⌘', '⇧', 'O']} /></TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
