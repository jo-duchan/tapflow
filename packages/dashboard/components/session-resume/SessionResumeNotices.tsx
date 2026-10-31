import type { RefObject } from 'react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { minutesLeft } from '@/lib/resumeEntry';
import type { DeviceSummary } from '@/lib/types';

// What a tester sees around a session they are coming back to (#1087). Above the device list, never instead of it:
// a waiting state sits on the list so another device is one click away, and a decision is a dialog over it.

const WAIT_TEXT = {
  'own-tab': (name: string) =>
    `Returning to your session on ${name}. It continues on its own once your other connection to it is closed or cleared.`,
  'ai-holding': (name: string) => `An AI client is using ${name}. You can continue your session when it is done.`,
  'mac-away': () => 'Waiting for the Mac running your device to come back.',
} as const;

/**
 * The tab is waiting to get back into its session. A status, not a dialog: it resolves on its own, and a dialog that
 * closed itself would move focus out from under the tester. Mounted with its text so the region exists before the
 * first change (`role="status"` inserted together with its sentence is often not announced) — the caller keeps it
 * mounted for as long as the wait lasts.
 */
export function ResumeWaitBanner({ why, deviceName, onCancel }: {
  why: keyof typeof WAIT_TEXT;
  deviceName?: string;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-3">
      <p role="status" className="text-sm">{WAIT_TEXT[why](deviceName ?? 'your device')}</p>
      <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
    </div>
  );
}

export interface InterruptedSession {
  agentName: string;
  device: DeviceSummary;
}

/** The tester's own sessions that dropped and are still waiting for them. One line each, with what they can do. */
export function InterruptedSessionsBanner({ sessions, onResume, onEnd, canResume = () => true }: {
  sessions: InterruptedSession[];
  onResume: (s: InterruptedSession) => void;
  onEnd: (s: InterruptedSession) => void;
  /** Away from the QA page a resume needs the build the session was on, which the relay may not know. */
  canResume?: (s: InterruptedSession) => boolean;
}) {
  if (sessions.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2" aria-label="Interrupted sessions">
      {sessions.map((s) => {
        const { device } = s;
        const borrowed = device.waiting?.aiHolding === true;
        const minutes = device.waiting?.remainingMs !== undefined ? minutesLeft(device.waiting.remainingMs) : null;
        return (
          <li key={device.sessionId} className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-3">
            <p className="text-sm">
              {borrowed
                ? `Your session on ${device.name} was interrupted. An AI client is using the device; you can continue when it is done.`
                : `Your session on ${device.name} was interrupted.${minutes !== null ? ` The device shuts down in about ${minutes} min.` : ''}`}
            </p>
            {/* Equal columns, as wide as the wider label: the pair reads as one choice. */}
            <div className="grid shrink-0 grid-flow-col auto-cols-fr gap-2">
              {!borrowed && canResume(s) && (
                <Button size="sm" onClick={() => onResume(s)} aria-label={`Resume your session on ${device.name}`}>Resume</Button>
              )}
              <Button variant="outline" size="sm" onClick={() => onEnd(s)} aria-label={`End your session on ${device.name}`}>End</Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Picking a device another person's dropped session is waiting on. Not refused — it is the same team, and a refusal
 * would need an admin to lift it — but the three things that decide it are said before it happens: whose it is, how
 * long it will wait, and that their app state goes.
 */
export function TakeOverDialog({ device, onCancel, onConfirm, returnFocusTo }: {
  device: DeviceSummary | null;
  onCancel: () => void;
  onConfirm: (d: DeviceSummary) => void;
  returnFocusTo: RefObject<HTMLElement | null>;
}) {
  const owner = device?.waiting?.name ?? 'Someone';
  return (
    <AlertDialog open={device !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent
        // Opened from a card's click, not a trigger, so Radix has nothing to return focus to.
        onCloseAutoFocus={(e) => { e.preventDefault(); returnFocusTo.current?.focus(); }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Take over {owner}&apos;s device?</AlertDialogTitle>
          <AlertDialogDescription>
            {owner}&apos;s connection dropped. Taking over ends their session, and the app state they were testing is
            lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className={buttonVariants({ variant: 'destructive' })} onClick={() => { if (device) onConfirm(device); }}>
            Take over
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * A session URL whose device is no longer the tester's to come back to: off, or on for someone else. Asked rather than
 * started — an old link opened by accident should not boot a simulator on the team's Mac.
 */
export function RestartDialog({ device, onClose, onStart, returnFocusTo }: {
  device: DeviceSummary | null;
  onClose: () => void;
  onStart: (d: DeviceSummary) => void;
  returnFocusTo: RefObject<HTMLElement | null>;
}) {
  return (
    <AlertDialog open={device !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <AlertDialogContent onCloseAutoFocus={(e) => { e.preventDefault(); returnFocusTo.current?.focus(); }}>
        <AlertDialogHeader>
          <AlertDialogTitle>Start {device?.name ?? 'the device'} again?</AlertDialogTitle>
          <AlertDialogDescription>
            Your previous session on it has ended. Starting it again installs this build from scratch.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Pick another device</AlertDialogCancel>
          <AlertDialogAction onClick={() => { if (device) onStart(device); }}>Start again</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
