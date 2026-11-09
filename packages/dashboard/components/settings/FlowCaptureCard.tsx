import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { queryKeys, setFlowCapture } from '@/lib/queries'
import type { AuthUser } from '@/hooks/useAuth'

/**
 * Whether the relay remembers this person's steps for Flow Capture (#1125). A personal setting, so it sits beside
 * Profile and Password; the QA Session's info card only shows it and says where to change it. Takes effect at once,
 * like the theme, with no Save: turning it off also discards what was remembered.
 */
export function FlowCaptureCard({ flowCapture }: { flowCapture: boolean }) {
  const queryClient = useQueryClient()
  // Written into the cached user at once, so the info card's chip follows the click; put back if the relay refuses.
  const mutation = useMutation({
    mutationFn: setFlowCapture,
    onMutate: async (on) => {
      // A `me` refetch already in flight (window focus) would land after this and put the old value back.
      await queryClient.cancelQueries({ queryKey: queryKeys.me })
      const before = queryClient.getQueryData<AuthUser | null>(queryKeys.me)
      if (before) queryClient.setQueryData<AuthUser>(queryKeys.me, { ...before, flowCapture: on })
      return { before }
    },
    onError: (_e, _on, ctx) => {
      if (ctx?.before) queryClient.setQueryData(queryKeys.me, ctx.before)
      toast.error('Could not change step capturing. Try again.')
    },
    onSuccess: (on) => {
      const now = queryClient.getQueryData<AuthUser | null>(queryKeys.me)
      if (now) queryClient.setQueryData<AuthUser>(queryKeys.me, { ...now, flowCapture: on })
    },
  })

  return (
    <Card>
      <CardHeader><CardTitle>Flow Capture</CardTitle></CardHeader>
      <CardContent>
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1">
            <Label htmlFor="flow-capture">Capture my steps</Label>
            <p id="flow-capture-hint" className="text-sm text-muted-foreground">
              Remember taps, swipes and typing in my sessions so I can save them as a flow. Kept only until the session ends.
            </p>
          </div>
          <Switch
            id="flow-capture"
            aria-describedby="flow-capture-hint"
            checked={flowCapture}
            onCheckedChange={(on) => mutation.mutate(on)}
          />
        </div>
      </CardContent>
    </Card>
  )
}
