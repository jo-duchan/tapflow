import * as React from "react"
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible"

import { cn } from "@/lib/utils"

/**
 * shadcn's Collapsible (Radix): a disclosure with no heading of its own, for a panel opened from inside a row or a form —
 * where Accordion's header would add a heading that titles nothing. Its content grows and shrinks as Accordion's does
 * (`collapsible-down` / `collapsible-up`, tailwind.config.ts), and not at all for reduced motion. Closed, it is not in
 * the DOM; a trigger that names it should do so only while it is open (`aria-controls`), as Radix's own would not.
 */
const Collapsible = CollapsiblePrimitive.Root

const CollapsibleTrigger = CollapsiblePrimitive.Trigger

const CollapsibleContent = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Content>
>(({ className, ...props }, ref) => (
  <CollapsiblePrimitive.Content
    ref={ref}
    className={cn(
      "overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none",
      className
    )}
    {...props}
  />
))
CollapsibleContent.displayName = CollapsiblePrimitive.Content.displayName

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
