import { Check } from "lucide-react"
import { cn } from "@/lib/utils"

export interface StepperStep {
  title: string
}

export type StepState = "completed" | "active" | "upcoming"

/**
 * Where a multi-step task stands (design/components/stepper.md). Drawn from shadcn/studio's Radix stepper, variant 04,
 * and built here rather than installed. **A progress list, not tabs**: the steps are taken in order, so the list is an
 * `<ol>` with `aria-current="step"`, and only a step the task can go to is a button (`canGoTo`) — a tab that cannot
 * be selected would announce an affordance that does nothing. A step can be completed while ahead of the current one:
 * one the task reached and stepped back from (`reached`).
 */
export function Stepper({
  steps,
  current,
  reached = current,
  label,
  canGoTo,
  onGoTo,
  className,
}: {
  steps: StepperStep[]
  /** The index of the step the task is on. */
  current: number
  /** The furthest step reached; those after `current` up to it show as completed. */
  reached?: number
  /** The list's accessible name. */
  label: string
  canGoTo?: (index: number) => boolean
  onGoTo?: (index: number) => void
  className?: string
}) {
  return (
    <ol aria-label={label} className={cn("flex min-w-0 items-center gap-2", className)}>
      {steps.map((step, i) => {
        const state: StepState = i === current ? "active" : i <= Math.max(current, reached) ? "completed" : "upcoming"
        const body = (
          <>
            <span
              data-slot="stepper-indicator"
              data-state={state}
              aria-hidden
              // Colour and ring ease in as a step is reached (shadcn/studio 04: 300 ms on the indicator).
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium ring-offset-background transition-all duration-300 motion-reduce:transition-none",
                state === "upcoming" ? "border-border text-muted-foreground" : "border-primary bg-primary text-primary-foreground",
                state === "active" && "ring-2 ring-primary/30 ring-offset-2",
              )}
            >
              {state === "completed" ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span
              data-slot="stepper-title"
              className={cn("whitespace-nowrap text-[13px] leading-5", state === "active" ? "font-medium text-foreground" : "text-muted-foreground")}
            >
              {step.title}
            </span>
            {state === "completed" && <span className="sr-only">, completed</span>}
          </>
        )
        const goable = state === "completed" && canGoTo?.(i) === true && onGoTo !== undefined
        return (
          <li key={step.title} data-slot="stepper-item" data-state={state} aria-current={state === "active" ? "step" : undefined} className="flex items-center gap-2">
            {goable ? (
              <button
                type="button"
                onClick={() => onGoTo(i)}
                className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background"
              >
                {body}
              </button>
            ) : (
              <span className="flex items-center gap-2 px-1.5 py-1">{body}</span>
            )}
            {i < steps.length - 1 && (
              // The line to the next step fills from the left once this one is done (500 ms, as in the reference).
              <span data-slot="stepper-separator" aria-hidden className="relative h-0.5 w-12 shrink overflow-hidden rounded-full bg-border">
                <span
                  className={cn(
                    "absolute inset-0 origin-left bg-primary transition-transform duration-500 ease-out motion-reduce:transition-none",
                    i < Math.max(current, reached) ? "scale-x-100" : "scale-x-0",
                  )}
                />
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}
