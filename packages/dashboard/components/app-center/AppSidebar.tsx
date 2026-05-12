import { TechLabel } from '@/components/ui/tech-label'
import type { App } from '@/lib/types'

interface Props {
  apps: App[]
  selectedAppId: number | null
  onSelect: (id: number) => void
}

export function AppSidebar({ apps, selectedAppId, onSelect }: Props) {
  return (
    <aside className="w-52 shrink-0 border-r flex flex-col gap-1 p-3 overflow-y-auto">
      <span className="px-2 pb-1 font-mono text-xs font-medium text-muted-foreground uppercase tracking-wider">
        Apps
      </span>
      {apps.length === 0 && (
        <span className="px-2 text-sm text-muted-foreground">No apps yet</span>
      )}
      {apps.map(app => (
        <button
          key={app.id}
          onClick={() => onSelect(app.id)}
          className={[
            'flex flex-col gap-0.5 rounded-md px-2 py-2 text-left text-sm hover:bg-accent',
            app.id === selectedAppId ? 'bg-accent font-medium' : '',
          ].join(' ')}
        >
          <span className="truncate">{app.name}</span>
          <TechLabel className="text-muted-foreground truncate">{app.bundle_id_key}</TechLabel>
        </button>
      ))}
    </aside>
  )
}
