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
import { Ellipsis, Play } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Build } from '@/lib/types';
import { PLATFORM_LABEL, STATUS_TONE, buildRowName, formatDeletionCountdown } from '@/lib/build-format';

interface Props {
  build: Build;
  isLast: boolean;
  onNavigate: (buildId: number) => void;
  onStatusChange: (buildId: number, status: string | null) => void;
  onScheduleDeletion: (buildId: number) => void;
  onCancelDeletion: (buildId: number) => void;
  /** Opens Edit build, which App Center holds: a version edit moves the row, and a dialog inside it would go too. */
  onEdit: (build: Build) => void;
  /** False for Viewer. The status Select and the ⋯ menu are then not rendered at all: the
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
  onEdit,
  canWrite,
  statusDescribedBy,
}: Props) {
  const [pendingSchedule, setPendingSchedule] = useState(false);
  // The dialog is opened from a menu item rather than an `AlertDialogTrigger`, so Radix has no trigger to hand focus
  // back to when it closes and drops it on `body`. It goes to the row's ⋯ instead, which also holds the item that
  // undoes a scheduled deletion.
  const menuRef = useRef<HTMLButtonElement>(null);
  // Different from the build file's when a person set them (#1084): `binary` says what the file says.
  const overridden = build.version_name !== build.binary.version_name || build.build_number !== build.binary.build_number;
  const fromFile = `From the build file: ${build.binary.version_name ?? 'no version'} (${build.binary.build_number ?? 'no build number'})`;
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
            menuRef.current?.focus();
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
            {/* Focusable, so the tooltip with the file's values opens for a keyboard too. A focused element needs a role
                and a name to be read at all, so it is an image named with the same words. */}
            {overridden && (
              <TooltipProvider delayDuration={400}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" tabIndex={0} role="img" aria-label={`Edited. ${fromFile}`} className="text-xs">
                      Edited
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>{fromFile}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {/* Not truncated: the line wraps, and a tooltip on cut-off text would not reach a keyboard. */}
            {build.version_label && <span className="text-sm text-muted-foreground">{build.version_label}</span>}
            <Badge
              tone={build.platform === 'ios' ? 'ios' : 'android'}
              className="text-xs"
            >
              {PLATFORM_LABEL[build.platform]}
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

        </>)}

        {/* The visible words first, so the name still contains what a voice-control user reads. */}
        <Button size="sm" onClick={() => onNavigate(build.id)} disabled={isDone} aria-label={`Start QA on ${rowName}`}>
          <Play className="mr-1.5 h-3.5 w-3.5" />
          Start QA
        </Button>

        {canWrite && (<>
        {/* Last on the row, as on the app and device cards: Start QA, the row's main action, sits by the status.
            Named per row like every control on it (`buildRowName`). `data-row-menu` is how Edit build finds this
            button again after a version edit has moved the row into another release. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button ref={menuRef} variant="ghost" size="icon-sm" aria-label={`Actions for ${rowName}`} data-row-menu={build.id}>
              <Ellipsis aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={() => onEdit(build)}>Edit build</DropdownMenuItem>
            <DropdownMenuSeparator />
            {deletion ? (
              // Undoes something rather than destroying anything, so it does not take the destructive look.
              <DropdownMenuItem onSelect={() => onCancelDeletion(build.id)}>Cancel scheduled deletion</DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => setPendingSchedule(true)}
                className="text-destructive focus:bg-destructive/10 focus:text-destructive">
                Schedule deletion
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        </>)}
      </div>
    </>
  );
}
