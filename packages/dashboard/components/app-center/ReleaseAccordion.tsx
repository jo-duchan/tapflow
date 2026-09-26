import { useId } from 'react'
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
  onScheduleDeletion: (buildId: number) => void
  onCancelDeletion: (buildId: number) => void
  /** False for Viewer: the rows show their status but offer no control that changes it. */
  canWrite: boolean
  /** Ids describing the header — App Center passes its status line to the first release, which is
   *  where focus lands when a retry brings the list back. */
  describedBy?: string
  /** A note for one row's status trigger — where focus lands when its neighbour left the filter. */
  rowNote?: { buildId: number; id: string }
}

export function ReleaseAccordion({
  versionName,
  builds,
  isOpen,
  onToggle,
  onNavigate,
  onStatusChange,
  onScheduleDeletion,
  onCancelDeletion,
  canWrite,
  describedBy,
  rowNote,
}: Props) {
  const panelId = useId()
  return (
    <div className="rounded-lg shadow-card-2 overflow-hidden">
      {/* A disclosure: the chevron is the only visible sign of open or closed, so the state has to be
          said as well. `aria-controls` only while the panel exists — it is not rendered when closed.

          **The focus ring is drawn inside.** The wrapper's `overflow-hidden` clips an outline drawn
          outside the button — on three sides when open, all four when closed — and this is where
          focus lands when a retry brings the list back. Inside twice over: the ring is inset, and so
          is the transparent outline `outline-none` leaves, because forced-colors mode drops the ring
          (a box-shadow) and paints that outline in a system colour instead.

          **Inside an `h2`**, as the APG accordion pattern has it: each header titles a section of
          rows, and the page's only other heading is the `h1` above the list, so without it a screen
          reader user could not move from release to release by heading. */}
      <h2>
      <button
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-accent/50 bg-card focus-visible:outline-none focus-visible:outline-offset-[-2px] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-controls={isOpen ? panelId : undefined}
        aria-describedby={describedBy}
        data-release-header={versionName}
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
      </h2>
      {isOpen && (
        <div id={panelId} className="border-t bg-card">
          {builds.map((b, idx) => (
            <BuildRow
              key={b.id}
              build={b}
              isLast={idx === builds.length - 1}
              onNavigate={onNavigate}
              onStatusChange={onStatusChange}
              onScheduleDeletion={onScheduleDeletion}
              onCancelDeletion={onCancelDeletion}
              canWrite={canWrite}
              statusDescribedBy={rowNote?.buildId === b.id ? rowNote.id : undefined}
            />
          ))}
        </div>
      )}
    </div>
  )
}
