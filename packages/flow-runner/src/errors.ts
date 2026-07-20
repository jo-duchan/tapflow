// A ui-tree query failure the runner should treat as transient — poll again until the step deadline
// instead of failing the step (e.g. the app isn't in the foreground yet right after launch, or the
// screen hasn't gone idle). Permanent failures (bad request, auth, missing session) are not wrapped
// in this and fail the step immediately.
export class TransientQueryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TransientQueryError'
  }
}
