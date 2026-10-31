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

// The procedure page, which is what this notice's reader needs. The old configuration anchor stays alive
// for dashboards already installed (docsAnchors.test.mjs LEGACY_URLS).
const DOCS_HTTPS_URL = 'https://www.tapflow.dev/operate/https#pick-a-method';

export function PerformanceModeNotice({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Streaming in Standard mode</DialogTitle>
          <DialogDescription className="space-y-3 pt-1">
            <span className="block">
              This screen is running in Standard mode. For a faster, smoother picture, switch to Smooth.
            </span>
            <span className="block">
              Smooth needs the relay served over HTTPS. If you didn&apos;t set up tapflow, ask whoever did.
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
