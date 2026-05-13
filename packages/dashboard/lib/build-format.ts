import type { Build } from '@/lib/types'

export const STATUS_TONE = {
  Backlog:       'backlog',
  'In Progress': 'progress',
  Done:          'done',
  Rejected:      'rejected',
} as const satisfies Record<string, 'backlog' | 'progress' | 'done' | 'rejected'>

export function buildLabel(build: Build): string {
  if (build.version_name && build.build_number) return `${build.version_name} · build ${build.build_number}`
  return build.version_name ?? build.version_label ?? (build.build_number ? `build ${build.build_number}` : 'Build')
}
