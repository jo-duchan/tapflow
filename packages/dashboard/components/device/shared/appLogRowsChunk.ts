import { createElement, lazy } from 'react'

type RowsModule = typeof import('./AppLogRows')
let rowsModule: RowsModule | null = null
let rowsLoading: Promise<RowsModule> | null = null

/**
 * Starts loading the rows' chunk (the virtualizer, #1233), which only a launched app's log needs. Called on launch, so
 * it is usually there before the first line. A failed load is kept, not retried: `lazy` below asks once per page and
 * keeps what it got, so a retry could not reach the box, and would only fetch a chunk that just failed again.
 */
export function loadAppLogRows(): Promise<RowsModule> {
  rowsLoading ??= import('./AppLogRows').then((loaded) => (rowsModule = loaded))
  return rowsLoading
}

/**
 * In the box when the chunk did not load: a relay upgraded under an open tab has renamed its chunks, or the network
 * dropped. Without it the error reached the page's root, which has no error boundary, and took the whole QA session
 * down with it. `lazy` keeps this for the page's life, hence "reload".
 */
const RowsUnavailable = () => createElement(
  'p',
  { className: 'px-2.5 py-1.5 text-xs text-muted-foreground' },
  'App logs could not load. Reload the page to see them.',
)

export const AppLogRows = lazy((): Promise<Pick<RowsModule, 'default'>> => {
  const loaded = rowsModule
  // Once loaded, handed over synchronously: `lazy` then renders the rows in the same commit instead of suspending a
  // frame with nothing in the box. React reads a thenable that resolves on `then` as already settled.
  if (loaded) return { then: (resolve: (module: RowsModule) => void) => resolve(loaded) } as unknown as Promise<RowsModule>
  return loadAppLogRows().catch(() => ({ default: RowsUnavailable as RowsModule['default'] }))
})
