import { ChevronDown, ChevronRight } from 'lucide-react'
import { TechLabel } from '@/components/ui/tech-label'
import { BuildRow } from './BuildRow'
import type { Build } from '@/lib/types'

interface Props {
  versionName: string
  builds: Build[]
  isOpen: boolean
  onToggle: () => void
  onNavigate: (buildId: number) => void
  onStatusChange: (buildId: number, status: string | null) => void
}

export function ReleaseAccordion({
  versionName,
  builds,
  isOpen,
  onToggle,
  onNavigate,
  onStatusChange,
}: Props) {
  return (
    <div className="rounded-lg shadow-card-2 overflow-hidden">
      <button
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-accent/50 bg-card"
        onClick={onToggle}
      >
        {isOpen
          ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        }
        <TechLabel className="font-medium text-sm text-foreground">{versionName}</TechLabel>
        <span className="text-xs text-muted-foreground">
          ({builds.length} build{builds.length > 1 ? 's' : ''})
        </span>
      </button>
      {isOpen && (
        <div className="border-t bg-card">
          {builds.map((b, idx) => (
            <BuildRow
              key={b.id}
              build={b}
              isLast={idx === builds.length - 1}
              onNavigate={onNavigate}
              onStatusChange={onStatusChange}
            />
          ))}
        </div>
      )}
    </div>
  )
}
