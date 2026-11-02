export const publicUrlWarningAnnouncement = 'This relay has no address teammates can open. Set TAPFLOW_RELAY_URL to a reachable address or configure a working tunnel public URL.'

export function PublicUrlWarning({ id }: { id: string }) {
  return (
    <div id={id} role="note" aria-labelledby={`${id}-label`} className="rounded-lg border border-warning-border bg-warning px-4 py-3 text-sm">
      <p id={`${id}-label`} className="font-medium text-warning-foreground">This relay has no address teammates can open.</p>
      <p className="mt-1">
        Set <code>TAPFLOW_RELAY_URL</code> to a reachable address or configure a working tunnel public URL.{' '}
        <a href="https://www.tapflow.dev/operate/docker" className="underline underline-offset-4">Docker setup</a>
      </p>
    </div>
  )
}
