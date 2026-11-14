import { useId } from 'react'
import { ChevronRight } from 'lucide-react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { cn } from '@/lib/utils'
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
  onEdit: (build: Build) => void
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
  onEdit,
  canWrite,
  describedBy,
  rowNote,
}: Props) {
  const panelId = useId()
  return (
    // shadcn's Accordion (Radix), one per release: App Center opens and closes each on its own, so the state stays the
    // page's (`isOpen`) and the panel grows and shrinks rather than appearing. A closed panel is not in the DOM, as before:
    // Radix removes it once its closing animation ends.
    <Accordion type="single" collapsible value={isOpen ? 'release' : ''} onValueChange={() => onToggle()} className="rounded-lg shadow-card-2 overflow-hidden">
      <AccordionItem value="release" className="border-b-0">
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
      <AccordionTrigger
        headerLevel={2}
        chevron={false}
        className="justify-start gap-2 px-4 py-3 font-normal hover:no-underline hover:bg-accent/50 bg-card focus-visible:ring-offset-0 focus-visible:outline-offset-[-2px] focus-visible:ring-inset"
        aria-controls={isOpen ? panelId : undefined}
        aria-describedby={describedBy}
        data-release-header={versionName}
      >
        <ChevronRight aria-hidden="true" className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none', isOpen && 'rotate-90')} />
        <TechLabel className="font-medium text-sm text-foreground">{versionName}</TechLabel>
        <span className="text-xs text-muted-foreground">
          ({builds.length} build{builds.length > 1 ? 's' : ''})
        </span>
      </AccordionTrigger>
      {/* No region landmark: releases open independently, and a landmark for each open one crowds the list of them. */}
      <AccordionContent id={panelId} role={undefined} className="border-t bg-card pb-0">
          {builds.map((b, idx) => (
            <BuildRow
              key={b.id}
              build={b}
              isLast={idx === builds.length - 1}
              onNavigate={onNavigate}
              onStatusChange={onStatusChange}
              onScheduleDeletion={onScheduleDeletion}
              onCancelDeletion={onCancelDeletion}
              onEdit={onEdit}
              canWrite={canWrite}
              statusDescribedBy={rowNote?.buildId === b.id ? rowNote.id : undefined}
            />
          ))}
      </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}
