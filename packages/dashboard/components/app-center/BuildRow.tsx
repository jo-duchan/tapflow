import { useState } from 'react';
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
import { Play, Trash2, Clock } from 'lucide-react';
import type { Build } from '@/lib/types';
import { STATUS_TONE } from '@/lib/build-format';

// delete_after is the absolute time the build is purged. Countdown is independent
// of the review status (issue #258).
function formatDeletionCountdown(deleteAfter: string): { label: string; urgent: boolean } {
  const diff = new Date(deleteAfter).getTime() - Date.now();
  if (diff <= 0) return { label: 'Deleting…', urgent: true };
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return { label: 'Deletes in < 1h', urgent: true };
  if (h < 24) return { label: `Deletes in ${h}h`, urgent: h < 6 };
  return { label: `Deletes in ${Math.floor(h / 24)}d`, urgent: false };
}

interface Props {
  build: Build;
  isLast: boolean;
  onNavigate: (buildId: number) => void;
  onStatusChange: (buildId: number, status: string | null) => void;
  onScheduleDeletion: (buildId: number) => void;
  onCancelDeletion: (buildId: number) => void;
}

export function BuildRow({
  build,
  isLast,
  onNavigate,
  onStatusChange,
  onScheduleDeletion,
  onCancelDeletion,
}: Props) {
  const [pendingSchedule, setPendingSchedule] = useState(false);
  const isDone = build.status_label === 'Done';
  const deletion = build.delete_after ? formatDeletionCountdown(build.delete_after) : null;

  function handleValueChange(val: string) {
    onStatusChange(build.id, val === 'none' ? null : val);
  }

  return (
    <>
      <AlertDialog open={pendingSchedule} onOpenChange={setPendingSchedule}>
        <AlertDialogContent>
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

        <Select value={build.status_label ?? 'none'} onValueChange={handleValueChange}>
          <SelectTrigger className="h-9 w-32 text-xs">
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

        {deletion ? (
          <Button
            size="icon-sm"
            variant="outline"
            onClick={() => onCancelDeletion(build.id)}
            title="Cancel scheduled deletion"
          >
            <Clock className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            size="icon-sm"
            variant="destructive"
            onClick={() => setPendingSchedule(true)}
            title="Schedule deletion"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}

        <Button size="sm" onClick={() => onNavigate(build.id)} disabled={isDone}>
          <Play className="mr-1.5 h-3.5 w-3.5" />
          Start QA
        </Button>
      </div>
    </>
  );
}
