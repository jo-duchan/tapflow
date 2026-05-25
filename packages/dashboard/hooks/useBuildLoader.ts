import { useEffect, useState } from 'react'
import { getBuild } from '@/lib/queries'
import type { Build } from '@/lib/types'

export function useBuildLoader(buildId: string | null): { build: Build | null } {
  const [build, setBuild] = useState<Build | null>(null)

  useEffect(() => {
    if (!buildId) return
    getBuild(buildId).then(setBuild)
  }, [buildId])

  return { build }
}
