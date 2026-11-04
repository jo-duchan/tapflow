import { agentUrlWarningBody, agentUrlWarningTitle } from './relayUrlWarningCopy'

export function AgentUrlWarning({ id }: { id: string }) {
  return (
    <div id={id} role="note" aria-labelledby={`${id}-label`} className="rounded-lg border border-warning-border bg-warning px-4 py-3 text-sm">
      <p id={`${id}-label`} className="font-medium text-warning-foreground">{agentUrlWarningTitle}</p>
      <p className="mt-1">
        {agentUrlWarningBody.beforeRelayUrl}<code>{agentUrlWarningBody.relayUrl}</code>{agentUrlWarningBody.afterRelayUrl}{' '}
        <a href="https://www.tapflow.dev/operate/docker" className="underline underline-offset-4">Docker setup</a>
      </p>
    </div>
  )
}
