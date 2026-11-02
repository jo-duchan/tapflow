export function AgentUrlWarning({ id }: { id: string }) {
  return (
    <div id={id} role="note" aria-labelledby={`${id}-label`} className="rounded-lg border border-warning-border bg-warning px-4 py-3 text-sm">
      <p id={`${id}-label`} className="font-medium text-warning-foreground">This relay has no address agents can use.</p>
      <p className="mt-1">
        Set <code>TAPFLOW_RELAY_URL</code> to an address the agent Mac can reach. A tunnel URL is for teammate browser links; agents connect directly to the relay.{' '}
        <a href="https://www.tapflow.dev/operate/docker" className="underline underline-offset-4">Docker setup</a>
      </p>
    </div>
  )
}
