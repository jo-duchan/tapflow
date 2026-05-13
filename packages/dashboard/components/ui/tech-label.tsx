import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * 기술 레이블 — build_number, bundle_id, version_name 등 기술적 식별자에 사용.
 * mono face + tabular-nums + tight tracking 을 캡슐화한다.
 */
export function TechLabel({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'font-mono text-xs tabular-nums tracking-tight',
        className,
      )}
      {...props}
    />
  )
}
