'use client';

import { useState, useEffect, useRef } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  /** Takes the url rather than a `send`, because the caller has to mint and record the correlation id
   *  that lets the viewer tell this deeplink's reply from someone else's on the same session. */
  openUrl: (url: string) => void;
}

export function DeepLinkDialog({ open, onOpenChange, onCloseAutoFocus, openUrl }: Props) {
  // Counted per opening and used as the form's key, so each opening starts empty. Unmounting on close
  // alone was not enough: Radix keeps the content mounted through its exit animation, and a dialog
  // reopened in that window kept what was typed. Adjusted while rendering, not from an effect.
  const [opening, setOpening] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setOpening((n) => n + 1);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-deeplink-dialog
        onCloseAutoFocus={onCloseAutoFocus}
        className="w-[500px] max-w-[500px] h-[52px] !rounded-[18px] p-[10px] border border-border bg-background shadow-lg overflow-hidden [&>button]:hidden"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Open Deeplink</DialogTitle>
        <DeepLinkForm key={opening} openUrl={openUrl} close={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The field lives in its own component, keyed per opening above — so each opening starts empty without
 * an effect clearing it (the effect ran a render late, and is what the rule flagged).
 */
function DeepLinkForm({ openUrl, close }: { openUrl: (url: string) => void; close: () => void }) {
  const [url, setUrl] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  const handleSubmit = () => {
    if (!url.trim()) return;
    openUrl(url.trim());
    close();
  };

  return (
    <>
        <div className="flex items-center gap-3">
          <div className="flex-1 h-[32px] flex items-center gap-2 pl-[4px] pb-[1px]">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
            <input
              ref={inputRef}
              // The dialog's own title is `sr-only` and not associated with the field, and a placeholder
              // is not a label — it disappears on the first keystroke. Without this the field is
              // announced as an unnamed edit box.
              aria-label="Deeplink URL"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground min-w-0"
              placeholder="myapp://home..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSubmit();
              }}
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
    </>
  );
}
