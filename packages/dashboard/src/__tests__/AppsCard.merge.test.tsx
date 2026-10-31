import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { App } from '@/lib/types'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import { AppsCard } from '@/components/settings/AppsCard'

/**
 * **Merge mode joins apps a person says are one product** (#1086), by dragging a bundle ID row onto another app —
 * from the keyboard too. jsdom lays nothing out, so each app's box is placed by its order: dnd-kit finds the drop
 * target by geometry.
 */
const app = (id: number, name: string, ios: string | null, android: string | null): App => ({
  id, name, bundle_id_key: ios ?? android, bundle_ids: { ios, android },
  build_platforms: [...(ios ? ['ios' as const] : []), ...(android ? ['android' as const] : [])],
  platform: ios && android ? 'both' : ios ? 'ios' : 'android',
  latest_build_id: null, version_name: null, build_number: null, status_label: null, latest_uploaded_at: null,
})
const APPS = [app(1, 'WDIO', 'org.wdiodemoapp', null), app(2, 'WDIO Android', null, 'com.wdiodemoapp')]

let fetchMock: ReturnType<typeof vi.spyOn>
let mergeAnswer: Response
beforeEach(() => {
  mergeAnswer = new Response(JSON.stringify({ ok: true, appId: 1, removedAppId: 2 }))
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => mergeAnswer)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const box = this.closest('[data-app-id], [data-drop-box]')
    const i = box ? [...document.querySelectorAll('[data-app-id], [data-drop-box]')].indexOf(box) : 0
    const top = i * 100 + (box === this ? 0 : 30)
    const height = box === this ? 90 : 20
    return { top, left: 0, width: 300, height, bottom: top + height, right: 300, x: 0, y: top, toJSON: () => ({}) } as DOMRect
  })
})
afterEach(() => vi.restoreAllMocks())

function renderCard(apps = APPS) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })
  const view = render(<QueryClientProvider client={client}><AppsCard apps={apps} /></QueryClientProvider>)
  /** What the apps refetch after a merge does to the card. */
  const refetched = (next: App[]) => view.rerender(<QueryClientProvider client={client}><AppsCard apps={next} /></QueryClientProvider>)
  return { ...view, refetched }
}

async function enterMergeMode() {
  const mode = screen.getByRole('button', { name: 'Arrange apps' })
  mode.focus()
  fireEvent.click(mode)
  expect(await screen.findByText('Drag a bundle ID onto another app, or into New app below its own.')).toBeInTheDocument()
  return mode
}

/** dnd-kit's keyboard path: pick up, move with the arrows, drop. It starts listening on a timer after the pick-up. */
async function dragFromKeyboard(grip: HTMLElement, moves: Array<'ArrowUp' | 'ArrowDown'>) {
  const press = async (code: string, key: string) => {
    await act(async () => {
      fireEvent.keyDown(grip, { code, key })
      await new Promise((r) => setTimeout(r, 10))
    })
  }
  grip.focus()
  await press('Space', ' ')
  for (const m of moves) await press(m, m)
  await press('Space', ' ')
}
const dragUpFromKeyboard = (grip: HTMLElement) => dragFromKeyboard(grip, ['ArrowUp'])

describe('merge mode', () => {
  it('keeps focus on the one button that enters and leaves it', async () => {
    renderCard()
    const mode = await enterMergeMode()
    expect(mode).toHaveTextContent('Done')
    expect(document.activeElement).toBe(mode)
  })

  it('merges from the keyboard, after saying what moves, and leaves the mode', async () => {
    const { refetched } = renderCard()
    const mode = await enterMergeMode()
    await dragUpFromKeyboard(screen.getByRole('button', { name: /Move com\.wdiodemoapp \(Android\)/ }))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Merge into WDIO?')
    expect(dialog).toHaveTextContent('WDIO Android is then removed.')
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/v1/apps/1/merge')
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ fromAppId: 2, platform: 'android' })
    expect(mode).toHaveTextContent('Arrange apps')
    // Two apps became one, so the refetch takes the mode button away; focus is on the kept app's menu, not on the page.
    refetched([app(1, 'WDIO', 'org.wdiodemoapp', 'com.wdiodemoapp')])
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions for WDIO' })))
  })

  // A teammate's merge or deletion, arriving by refetch, can leave one app while the mode is on.
  it('can still be left when a refetch leaves one app', async () => {
    const { refetched } = renderCard()
    const mode = await enterMergeMode()
    refetched([app(1, 'WDIO', 'org.wdiodemoapp', null)])
    expect(mode).toBeInTheDocument()
    fireEvent.click(mode)
    expect(screen.queryByText('Drag a bundle ID onto another app, or into New app below its own.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Arrange apps' })).not.toBeInTheDocument()
  })

  it('puts focus back on the dropped row when the merge is cancelled', async () => {
    renderCard()
    await enterMergeMode()
    const grip = screen.getByRole('button', { name: /Move com\.wdiodemoapp \(Android\)/ })
    await dragUpFromKeyboard(grip)
    // While it asks, the row is shown landed in WDIO and faded where it still is.
    await screen.findByRole('alertdialog')
    expect(document.querySelector('[data-app-id="1"] [data-preview]')).toHaveTextContent('com.wdiodemoapp')
    expect(grip.parentElement).toHaveClass('opacity-40')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(document.activeElement).toBe(grip))
    expect(document.querySelector('[data-preview]')).toBeNull()
    expect(grip.parentElement).not.toHaveClass('opacity-40')
  })

  // Each press lands the row on the next app it can go to, and the row moves back up off one it is on.
  it('moves between apps with the arrow keys in both directions', async () => {
    renderCard([app(1, 'Mover', null, 'com.mover'), app(2, 'First', 'org.first', null), app(3, 'Second', 'org.second', null)])
    await enterMergeMode()
    await dragFromKeyboard(screen.getByRole('button', { name: /Move com\.mover \(Android\)/ }), ['ArrowDown', 'ArrowDown', 'ArrowUp'])
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Merge into First?')
  })

  // A toast is hidden from screen readers while the dialog is open, so the refusal is said inside it.
  it('says a refusal inside the dialog and stays open', async () => {
    mergeAnswer = new Response(JSON.stringify({ error: 'That app has builds carrying the bundle ID of its other platform' }), { status: 409 })
    renderCard()
    await enterMergeMode()
    await dragUpFromKeyboard(screen.getByRole('button', { name: /Move com\.wdiodemoapp \(Android\)/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }))

    const dialog = screen.getByRole('alertdialog')
    await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('builds carrying the bundle ID'))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('gives a row of an app using one ID on both platforms no grip, and leaves it still', async () => {
    renderCard([app(1, 'Other', 'org.other', null), app(2, 'Same', 'com.same', 'com.same')])
    await enterMergeMode()
    expect(screen.queryByRole('button', { name: /Move com\.same/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Move org\.other/ }).parentElement).toHaveClass('animate-row-wiggle')
    const still = screen.getAllByText('com.same')[0]!.closest('[tabindex]')!
    expect(still).not.toHaveClass('animate-row-wiggle')
    // A keyboard reaches it, and with it the reason.
    expect(still).toHaveAttribute('tabindex', '0')
  })

  // The keyboard only stops on apps a row can go to; a mouse can let go anywhere, so the drop is checked again.
  // Last in the file: in jsdom a pointer drag leaves dnd-kit listening on the window, which swallowed the next test's click.
  it('asks nothing when a row is dropped with the mouse on an app that already has that platform', async () => {
    renderCard([app(1, 'Taken', null, 'com.taken'), app(2, 'Mover', null, 'com.mover')])
    await enterMergeMode()
    const grip = screen.getByRole('button', { name: /Move com\.mover \(Android\)/ })
    const pointer = { pointerId: 1, isPrimary: true, button: 0 }
    await act(async () => {
      fireEvent.pointerDown(grip, { ...pointer, clientX: 10, clientY: 135 })
      await new Promise((r) => setTimeout(r, 10))
    })
    await act(async () => {
      fireEvent.pointerMove(document, { ...pointer, clientX: 10, clientY: 40 })
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(document.querySelector('[data-app-id="1"]')).toHaveClass('opacity-50')
    await act(async () => {
      fireEvent.pointerUp(document, { ...pointer, clientX: 10, clientY: 40 })
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})
