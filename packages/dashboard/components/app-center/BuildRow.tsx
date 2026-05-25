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
            <AlertDialogTitle>Done으로 변경하시겠습니까?</AlertDialogTitle>
            <AlertDialogDescription>
              Done으로 변경하면 7일 후 빌드 파일이 자동으로 삭제됩니다.
              상태를 되돌리면 삭제 일정이 취소됩니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction onClick={() => { onStatusChange(build.id, 'Done'); setPendingDone(false) }}>
              확인
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
          <p className="text-xs text-muted-foreground mt-0.5">
            {build.uploader
              ? <>{build.uploader} · <TechLabel>{new Date(build.uploaded_at).toLocaleDateString()}</TechLabel></>
              : <TechLabel>{new Date(build.uploaded_at).toLocaleDateString()}</TechLabel>
            }
            {expiry && (
              <span className={`ml-1.5 ${expiry.urgent ? 'text-destructive' : ''}`}>
                · {expiry.label}
              </span>
            )}
          </p>
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
