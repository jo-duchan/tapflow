'use client';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { PerformanceMode } from '@/lib/decoders/pickDecoder';

export const PERF_NOTICE_KEY = 'tapflow.perfModeNoticeDismissed';
const DOCS_HTTPS_URL = 'https://www.tapflow.dev/reference/configuration#https-secure-context';

// Auto-show only in Standard mode and only if not dismissed before (once per browser).
export function shouldAutoShowPerfNotice(mode: PerformanceMode, dismissed: boolean): boolean {
  return mode === 'standard' && !dismissed;
}

export function PerformanceModeNotice({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Streaming in Standard mode</DialogTitle>
          <DialogDescription className="space-y-3 pt-1">
            <span className="block">
              This screen is running in Standard mode. For a faster, smoother picture, switch to High performance.
            </span>
            <span className="block">
              High performance needs the relay served over HTTPS. If you didn&apos;t set up tapflow, ask whoever did.
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => window.open(DOCS_HTTPS_URL, '_blank', 'noopener,noreferrer')}>
            How to enable
          </Button>
          <Button onClick={() => onOpenChange(false)}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
