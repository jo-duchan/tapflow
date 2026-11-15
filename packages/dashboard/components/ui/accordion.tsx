import * as React from "react"
import * as AccordionPrimitive from "@radix-ui/react-accordion"
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * shadcn's Accordion (Radix). The panel's height is animated by `accordion-down` / `accordion-up` (tailwind.config.ts)
 * on Radix's `--radix-accordion-content-height`, and not at all for a person who asked for reduced motion. Radix keeps
 * a closing panel mounted until its animation ends, then removes it: a closed panel is not in the DOM.
 */
const Accordion = AccordionPrimitive.Root

const AccordionItem = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>
>(({ className, ...props }, ref) => (
  <AccordionPrimitive.Item ref={ref} className={cn("border-b", className)} {...props} />
))
AccordionItem.displayName = "AccordionItem"

/** The header row. `headerLevel` picks the heading element Radix's header renders (an `h3` by default). */
const AccordionTrigger = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger> & { headerLevel?: 2 | 3 | 4; chevron?: boolean }
>(({ className, children, headerLevel = 3, chevron = true, ...props }, ref) => {
  const Heading = `h${headerLevel}` as const
  return (
    <AccordionPrimitive.Header asChild className="flex">
      <Heading>
        <AccordionPrimitive.Trigger
          ref={ref}
          className={cn(
            "flex flex-1 items-center justify-between gap-4 py-4 text-left text-sm font-medium transition-all hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background [&[data-state=open]>svg.accordion-chevron]:rotate-180",
            className
          )}
          {...props}
        >
          {children}
          {chevron && <ChevronDown aria-hidden="true" className="accordion-chevron h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none" />}
        </AccordionPrimitive.Trigger>
      </Heading>
    </AccordionPrimitive.Header>
  )
})
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName

const AccordionContent = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Content
    ref={ref}
    className="overflow-hidden text-sm data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down motion-reduce:animate-none"
    {...props}
  >
    <div className={cn("pb-4 pt-0", className)}>{children}</div>
  </AccordionPrimitive.Content>
))
AccordionContent.displayName = AccordionPrimitive.Content.displayName

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
