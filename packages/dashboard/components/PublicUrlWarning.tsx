import { publicUrlWarningBody, publicUrlWarningTitle } from './relayUrlWarningCopy'

export function PublicUrlWarning({ id }: { id: string }) {
  return (
    <div id={id} role="note" aria-labelledby={`${id}-label`} className="rounded-lg border border-warning-border bg-warning px-4 py-3 text-sm">
      <p id={`${id}-label`} className="font-medium text-warning-foreground">{publicUrlWarningTitle}</p>
      <p className="mt-1">
        {publicUrlWarningBody.beforeRelayUrl}<code>{publicUrlWarningBody.relayUrl}</code>{publicUrlWarningBody.afterRelayUrl}{' '}
        <a href="https://www.tapflow.dev/operate/docker" className="underline underline-offset-4">Docker setup</a>
      </p>
    </div>
  )
}
