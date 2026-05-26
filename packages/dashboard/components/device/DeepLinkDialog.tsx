'use client';

import { useState, useEffect } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  send: (msg: object) => void;
}

export function DeepLinkDialog({ open, onOpenChange, sessionId, send }: Props) {
  const [url, setUrl] = useState('');

  useEffect(() => {
    if (!open) setUrl('');
  }, [open]);

  const handleSubmit = () => {
    if (!url.trim()) return;
    send({ type: 'open-url', sessionId, payload: { url: url.trim() } });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[500px] max-w-[500px] h-[52px] !rounded-[18px] p-[10px] border border-border bg-background shadow-lg overflow-hidden [&>button]:hidden"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Open Deeplink</DialogTitle>
        <div className="flex items-center gap-3">
          <div className="flex-1 h-[32px] flex items-center gap-2 pl-[4px] pb-[1px]">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            <input
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground min-w-0"
              placeholder="myapp://home..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSubmit();
              }}
              autoFocus
            />
          </div>
          <Button
            size="sm"
            disabled={!url.trim()}
            onClick={handleSubmit}
            className="shrink-0 rounded-xl h-8 px-4"
          >
            Open
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
