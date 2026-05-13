import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TechLabel } from '@/components/ui/tech-label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Play } from 'lucide-react'
import type { Build } from '@/lib/types'
import { STATUS_TONE } from '@/lib/build-format'

interface Props {
  build: Build
  isLast: boolean
  onNavigate: (buildId: number) => void
  onStatusChange: (buildId: number, status: string | null) => void
}

export function BuildRow({ build, isLast, onNavigate, onStatusChange }: Props) {
  return (
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
          {build.uploader ?? '—'} · <TechLabel>{new Date(build.uploaded_at).toLocaleDateString()}</TechLabel>
        </p>
      </div>

      <Select
        value={build.status_label ?? 'none'}
        onValueChange={(val) => onStatusChange(build.id, val === 'none' ? null : val)}
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

      <Button size="sm" onClick={() => onNavigate(build.id)}>
        <Play className="mr-1.5 h-3.5 w-3.5" />
        Start QA
      </Button>
    </div>
  )
}
