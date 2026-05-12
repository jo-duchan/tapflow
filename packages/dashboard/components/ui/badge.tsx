import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'text-foreground',
      },
      /** QA 상태 + 플랫폼 전용 시맨틱 tone — DESIGN.md 색상 스케일 기반 */
      tone: {
        backlog:  'border-transparent bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
        progress: 'border-transparent bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
        done:     'border-transparent bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300',
        rejected: 'border-transparent bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
        ios:      'border-transparent bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
        android:  'border-transparent bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
      },
    },
    defaultVariants: { variant: 'default' },
  }
)

interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, tone, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant, tone }), className)} {...props} />
}

export { Badge, badgeVariants }
