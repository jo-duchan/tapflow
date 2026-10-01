import type { ReactNode } from 'react';
import { Ellipsis } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export interface OverflowItem {
  key: string;
  label: string;
  icon: ReactNode;
  /** Stay open after this item runs — for one pressed several times in a row, like volume. */
  keepOpen?: boolean;
  onSelect: () => void;
}

/**
 * A toolbar group's "⋯" menu: where its less-used buttons go once the group outgrows about four
 * (`packages/dashboard/AGENTS.md` → "When a group gets too long"). Generic on purpose — each item
 * carries its own action, so the menu does not know what it holds, and the next group to need one
 * uses this rather than a copy.
 *
 * A menu rather than a popover because a list of actions is the WAI-ARIA menu pattern, which Radix
 * supplies whole: arrow keys move, Enter runs, Escape closes and returns focus to the trigger. `label`
 * is the trigger's name and tooltip; the icon alone says nothing.
 */
export function ToolbarOverflowMenu({ label, items, icon = <Ellipsis className="h-4 w-4" /> }: {
  label: string;
  items: OverflowItem[];
  icon?: ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={label}>
              {icon}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="left">{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="left" align="start">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.key}
            onSelect={(e) => {
              if (item.keepOpen) e.preventDefault();
              item.onSelect();
            }}
          >
            <span aria-hidden="true" className="[&>svg]:h-4 [&>svg]:w-4">{item.icon}</span>
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
