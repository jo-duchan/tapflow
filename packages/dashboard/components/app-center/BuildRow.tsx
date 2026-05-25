import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TechLabel } from '@/components/ui/tech-label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Separator } from '@/components/ui/separator'
import { Play } from 'lucide-react'
import type { Build } from '@/lib/types'
import { STATUS_TONE } from '@/lib/build-format'

function formatBuildExpiry(completedAt: string): { label: string; urgent: boolean } {
  const TTL_DAYS = 7
  const expiresAt = new Date(completedAt).getTime() + TTL_DAYS * 24 * 3_600_000
  const diff = expiresAt - Date.now()
  if (diff <= 0) return { label: 'Expired', urgent: true }
  const h = Math.floor(diff / 3_600_000)
  if (h < 1) return { label: '< 1 hour left', urgent: true }
  if (h < 24) return { label: `Expires in ${h}h`, urgent: h < 6 }
  return { label: `Expires in ${Math.floor(h / 24)}d`, urgent: false }
}

interface Props {
  build: Build
  isLast: boolean
  onNavigate: (buildId: number) => void
  onStatusChange: (buildId: number, status: string | null) => void
}

export function BuildRow({ build, isLast, onNavigate, onStatusChange }: Props) {
  const [pendingDone, setPendingDone] = useState(false)
  const isDone = build.status_label === 'Done'
  const expiry = isDone && build.completed_at ? formatBuildExpiry(build.completed_at) : null

  function handleValueChange(val: string) {
    if (val === 'Done') {
      setPendingDone(true)
      return
    }
    onStatusChange(build.id, val === 'none' ? null : val)
  }

  return (
    <>
      <AlertDialog open={pendingDone} onOpenChange={setPendingDone}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark as Done?</AlertDialogTitle>
            <AlertDialogDescription>
              Build files will be automatically deleted after 7 days.
              Reverting the status will cancel the scheduled deletion.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { onStatusChange(build.id, 'Done'); setPendingDone(false) }}>
              Confirm
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
            <Badge tone={build.platform === 'ios' ? 'ios' : 'android'} className="text-xs capitalize">
              {build.platform}
            </Badge>
            {build.status_label && (
              <Badge tone={STATUS_TONE[build.status_label]} className="text-xs">
                {build.status_label}
              </Badge>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'row', gap: '14px', marginTop: '0.7rem', alignItems: 'center' }} className="text-xs text-muted-foreground">
            {build.uploader && (
              <>
                <span>{build.uploader}</span>
                <Separator orientation="vertical" className="h-3" />
              </>
            )}
            <TechLabel>{new Date(build.uploaded_at).toLocaleDateString()}</TechLabel>
            {expiry && (
              <>
                <Separator orientation="vertical" className="h-3" />
                <span className={expiry.urgent ? 'text-destructive' : ''}>{expiry.label}</span>
              </>
            )}
          </div>
        </div>

        <Select
          value={build.status_label ?? 'none'}
          onValueChange={handleValueChange}
        >
          <SelectTrigger className="h-9 w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none"><span className="text-muted-foreground">—</span></SelectItem>
            <SelectItem value="Backlog">Backlog</SelectItem>
            <SelectItem value="In Progress">In Progress</SelectItem>
            <SelectItem value="Done">Done</SelectItem>
            <SelectItem value="Rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>

        <Button size="sm" onClick={() => onNavigate(build.id)} disabled={isDone}>
          <Play className="mr-1.5 h-3.5 w-3.5" />
          Start QA
        </Button>
      </div>
    </>
  )
}
