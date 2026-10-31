export function PublicUrlWarning({ id }: { id: string }) {
  return (
    <div id={id} role="note" aria-labelledby={`${id}-label`} className="rounded-md border border-border bg-muted/40 p-3 text-sm">
      <p id={`${id}-label`} className="font-medium">Teammates cannot open this relay&apos;s public URL.</p>
      <p className="mt-1 text-foreground">
        Set <code>TAPFLOW_RELAY_URL</code> to a reachable address or configure a working tunnel public URL.{' '}
        <a href="https://www.tapflow.dev/operate/docker" className="underline underline-offset-4">Docker setup</a>
      </p>
    </div>
  )
}
