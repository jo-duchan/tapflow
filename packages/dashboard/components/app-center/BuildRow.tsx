import { useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TechLabel } from '@/components/ui/tech-label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Play, Trash2, TimerOff } from 'lucide-react';
import type { Build } from '@/lib/types';
import { STATUS_TONE, buildRowName, formatDeletionCountdown } from '@/lib/build-format';

interface Props {
  build: Build;
  isLast: boolean;
  onNavigate: (buildId: number) => void;
  onStatusChange: (buildId: number, status: string | null) => void;
  onScheduleDeletion: (buildId: number) => void;
  onCancelDeletion: (buildId: number) => void;
  /** False for Viewer. The status Select and the deletion button are then not rendered at all: the
   *  status and deletion badges already say the state, and a control that can only be refused is
   *  one more stop in the tab order with nothing behind it. */
  canWrite: boolean;
  /** Describes the status trigger — App Center passes a note here when this row is where focus
   *  lands after the row above or below it left the filtered list (#833). */
  statusDescribedBy?: string;
}

export function BuildRow({
  build,
  isLast,
  onNavigate,
  onStatusChange,
  onScheduleDeletion,
  onCancelDeletion,
  canWrite,
  statusDescribedBy,
}: Props) {
  const [pendingSchedule, setPendingSchedule] = useState(false);
  // The dialog is opened by state rather than by an `AlertDialogTrigger`, so Radix has no trigger to
  // hand focus back to when it closes and drops it on `body`. This is where it goes instead: the
  // button that opened it. Its slot holds "Schedule deletion" or "Cancel scheduled deletion" — the
  // same `Button` in the same position either way, so it is the same node after a deletion is
  // scheduled and focus lands on the control that can undo it.
  const deletionButtonRef = useRef<HTMLButtonElement>(null);
  const isDone = build.status_label === 'Done';
  const deletion = build.delete_after ? formatDeletionCountdown(build.delete_after) : null;
  const rowName = buildRowName(build);

  function handleValueChange(val: string) {
    onStatusChange(build.id, val === 'none' ? null : val);
  }

  return (
    <>
      <AlertDialog open={pendingSchedule} onOpenChange={setPendingSchedule}>
        <AlertDialogContent
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            deletionButtonRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Schedule deletion?</AlertDialogTitle>
            <AlertDialogDescription>
              Build files will be deleted after 7 days. You can cancel the scheduled deletion
              anytime before then.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onScheduleDeletion(build.id);
                setPendingSchedule(false);
              }}
            >
              Schedule deletion
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className={['flex items-center gap-3 px-4 py-3', !isLast ? 'border-b' : ''].join(' ')}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">
              build <TechLabel>{build.build_number ?? '—'}</TechLabel>
            </span>
            <Badge
              tone={build.platform === 'ios' ? 'ios' : 'android'}
              className="text-xs capitalize"
            >
              {build.platform}
            </Badge>
            {build.status_label && (
              <Badge tone={STATUS_TONE[build.status_label]} className="text-xs">
                {build.status_label}
              </Badge>
            )}
            {deletion && (
              <Badge tone={deletion.urgent ? 'rejected' : 'backlog'} className="text-xs">
                {deletion.label}
              </Badge>
            )}
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              gap: '14px',
              marginTop: '0.7rem',
              alignItems: 'center',
            }}
            className="text-xs text-muted-foreground"
          >
            {build.uploader && (
              <>
                <span>{build.uploader}</span>
                <Separator orientation="vertical" className="h-3" />
              </>
            )}
            <TechLabel>{new Date(build.uploaded_at).toLocaleDateString()}</TechLabel>
          </div>
        </div>

        {canWrite && (<>
        <Select value={build.status_label ?? 'none'} onValueChange={handleValueChange}>
          {/* Every control on the row is named from `buildRowName` — see it for why the number
              alone is not enough. `data-status-trigger` is how App Center finds this trigger to
              move focus onto it when a neighbouring row leaves the filtered list. */}
          <SelectTrigger
            className="h-9 w-32 text-xs"
            aria-label={`Status for ${rowName}`}
            aria-describedby={statusDescribedBy}
            data-status-trigger={build.id}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">
              <span className="text-muted-foreground">—</span>
            </SelectItem>
            <SelectItem value="Backlog">Backlog</SelectItem>
            <SelectItem value="In Progress">In Progress</SelectItem>
            <SelectItem value="Done">Done</SelectItem>
            <SelectItem value="Rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>

        {/* Named per row, and explained by a tooltip that also opens on keyboard focus. `title` did
            neither: it was the same on every row, so voice control could not address one, and it
            appears on hover only, so a keyboard user landing on the icon could not tell what it does.
            One `Tooltip` around both branches: the slot keeps the same node either way (see
            `deletionButtonRef`), and so does the trigger wrapping it. */}
        <TooltipProvider delayDuration={400}>
          <Tooltip>
            <TooltipTrigger asChild>
              {deletion ? (
                <Button
                  ref={deletionButtonRef}
                  size="icon-sm"
                  variant="outline"
                  onClick={() => onCancelDeletion(build.id)}
                  aria-label={`Cancel scheduled deletion of ${rowName}`}
                >
                  <TimerOff className="h-3.5 w-3.5" aria-hidden />
                </Button>
              ) : (
                <Button
                  ref={deletionButtonRef}
                  size="icon-sm"
                  variant="destructive"
                  onClick={() => setPendingSchedule(true)}
                  aria-label={`Schedule deletion of ${rowName}`}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              )}
            </TooltipTrigger>
            <TooltipContent>{deletion ? 'Cancel scheduled deletion' : 'Schedule deletion'}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        </>)}

        {/* The visible words first, so the name still contains what a voice-control user reads. */}
        <Button size="sm" onClick={() => onNavigate(build.id)} disabled={isDone} aria-label={`Start QA on ${rowName}`}>
          <Play className="mr-1.5 h-3.5 w-3.5" />
          Start QA
        </Button>
      </div>
    </>
  );
}
