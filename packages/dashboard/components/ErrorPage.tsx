interface ErrorPageProps {
  code: string | number
  message: string
}

/** Minimal full-screen error state: `code │ message`, centered. Token-only for dark mode. */
export function ErrorPage({ code, message }: ErrorPageProps) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-4">
      <div className="flex items-center gap-4">
        <span className="text-lg font-semibold tracking-tight text-foreground">{code}</span>
        <span className="h-6 w-px bg-border" aria-hidden="true" />
        <span className="text-sm text-muted-foreground">{message}</span>
      </div>
    </div>
  )
}
