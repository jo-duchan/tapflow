import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { App } from '@/lib/types'
import { getApps, queryKeys } from '@/lib/queries'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import { AppsCard } from '@/components/settings/AppsCard'

/**
 * **Splitting is merging the other way** (#1086): a bundle ID row dropped into New app, below its own app, becomes an
 * app of its own. The card reads its apps through the real query here, because the dialog waits for the list that has
 * the new app before it closes — a harness that hands the card a new list by hand would pass without that wait.
 */
const app = (id: number, name: string, ios: string | null, android: string | null): App => ({
  id, name, bundle_id_key: ios ?? android, bundle_ids: { ios, android },
  build_platforms: [...(ios ? ['ios' as const] : []), ...(android ? ['android' as const] : [])],
  platform: ios && android ? 'both' : ios ? 'ios' : 'android',
  latest_build_id: null, version_name: null, build_number: null, status_label: null, latest_uploaded_at: null,
})
const JOINED = app(1, 'Joined', 'org.joined', 'com.joined')
const OTHER = app(2, 'Other', 'org.other', null)
const AFTER = [app(3, 'Joined Android', null, 'com.joined'), app(1, 'Joined', 'org.joined', null), OTHER]

let fetchMock: ReturnType<typeof vi.spyOn>
let serverApps: App[]
let splitAnswer: Response
/** Holds the next list request until released, so the test can look at the dialog while the refetch is in flight. */
let held: { promise: Promise<void>; release: () => void } | null
let listFails: boolean
beforeEach(() => {
  serverApps = [JOINED, OTHER]
  splitAnswer = new Response(JSON.stringify({ ok: true, appId: 3 }))
  held = null
  listFails = false
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) === '/api/v1/apps' && !init?.method) {
      if (held) await held.promise
      return listFails ? new Response('{}', { status: 500 }) : new Response(JSON.stringify({ items: serverApps }))
    }
    return String(url).endsWith('/merge') ? new Response(JSON.stringify({ ok: true, appId: 2 })) : splitAnswer
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const box = this.closest('[data-app-id], [data-drop-box]')
    const i = box ? [...document.querySelectorAll('[data-app-id], [data-drop-box]')].indexOf(box) : 0
    const top = i * 100 + (box === this ? 0 : 30)
    const height = box === this ? 90 : 20
    return { top, left: 0, width: 300, height, bottom: top + height, right: 300, x: 0, y: top, toJSON: () => ({}) } as DOMRect
  })
})
afterEach(() => vi.restoreAllMocks())

function hold() {
  let release!: () => void
  const promise = new Promise<void>((r) => { release = r })
  held = { promise, release }
  return held
}

function Settings() {
  const { data } = useQuery({ queryKey: queryKeys.apps, queryFn: getApps })
  return data ? <AppsCard apps={data} /> : null
}

async function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })
  render(<QueryClientProvider client={client}><Settings /></QueryClientProvider>)
  const mode = await screen.findByRole('button', { name: 'Arrange apps' })
  mode.focus()
  fireEvent.click(mode)
  return mode
}

const press = async (target: HTMLElement, code: string, key: string) => {
  await act(async () => {
    fireEvent.keyDown(target, { code, key })
    await new Promise((r) => setTimeout(r, 10))
  })
}
const grip = (name: RegExp) => screen.getByRole('button', { name })

/** Picks the Joined app's Android row up and moves it one stop down: New app, right below Joined. */
async function dropIntoNewApp() {
  const handle = grip(/Move com\.joined \(Android\)/)
  handle.focus()
  await press(handle, 'Space', ' ')
  await press(handle, 'ArrowDown', 'ArrowDown')
  await press(handle, 'Space', ' ')
  return handle
}

describe('splitting', () => {
  it('opens New app right below the picked-up row\'s own app, and nowhere else', async () => {
    await renderCard()
    expect(document.querySelector('[data-drop-box]')).toBeNull()
    const handle = grip(/Move com\.joined \(Android\)/)
    handle.focus()
    await press(handle, 'Space', ' ')

    const zones = document.querySelectorAll('[data-drop-box]')
    expect(zones).toHaveLength(1)
    expect(document.querySelector('[data-app-id="1"]')!.nextElementSibling).toBe(zones[0])
    await press(handle, 'Escape', 'Escape')
  })

  // Splitting off all an app has would only rename it, so the relay refuses it and the area does not open.
  it('opens no New app for a row whose app has nothing else', async () => {
    await renderCard()
    const handle = grip(/Move org\.other \(iOS\)/)
    handle.focus()
    await press(handle, 'Space', ' ')
    expect(document.querySelector('[data-drop-box]')).toBeNull()
    await press(handle, 'Escape', 'Escape')
  })

  it('splits from the keyboard, and closes on the list that has the new app, with focus on its menu', async () => {
    await renderCard()
    await dropIntoNewApp()

    const field = await screen.findByLabelText('New app name')
    expect(field).toHaveValue('Joined (Android)')
    expect(document.activeElement).toBe(field)
    fireEvent.change(field, { target: { value: '  Joined Android ' } })

    const refetch = hold()
    serverApps = AFTER
    fireEvent.click(screen.getByRole('button', { name: 'Split' }))
    const splitCall = () => fetchMock.mock.calls.find((call: unknown[]) => String(call[0]).endsWith('/split'))
    await waitFor(() => expect(splitCall()).toBeDefined())
    const [url, init] = splitCall()!
    expect(url).toBe('/api/v1/apps/1/split')
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ platform: 'android', name: 'Joined Android' })

    // The relay has answered; the list with the new app has not arrived, so the dialog waits.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Splitting…' })).toBeInTheDocument()

    refetch.release()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions for Joined Android' })))
    expect(screen.getByRole('button', { name: 'Arrange apps' })).toBeInTheDocument()
  })

  // A list that fails to come back must not leave the dialog waiting for ever.
  it('closes anyway when the list cannot be read again', async () => {
    await renderCard()
    await dropIntoNewApp()
    listFails = true
    fireEvent.click(await screen.findByRole('button', { name: 'Split' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  // A list that never answers (a dead connection) would leave it busy with no way out. Real time: fake timers stall the
  // drag sensors this file drives.
  it('closes after a few seconds when the list does not answer', async () => {
    await renderCard()
    await dropIntoNewApp()
    hold()
    fireEvent.click(await screen.findByRole('button', { name: 'Split' }))
    await act(async () => { await new Promise((r) => setTimeout(r, 3000)) })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 4000 })
  }, 12000)

  it('says a refusal inside the dialog and stays open', async () => {
    splitAnswer = new Response(JSON.stringify({ error: 'That app has builds carrying the bundle ID of its other platform' }), { status: 409 })
    await renderCard()
    await dropIntoNewApp()
    fireEvent.click(await screen.findByRole('button', { name: 'Split' }))
    const dialog = screen.getByRole('dialog')
    await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('builds carrying the bundle ID'))
    expect(screen.getByRole('button', { name: 'Split' })).toBeInTheDocument()
  })

  it('shows the row in New app while it asks, and puts it and focus back when cancelled', async () => {
    await renderCard()
    const handle = await dropIntoNewApp()
    await screen.findByRole('dialog')
    expect(document.querySelector('[data-drop-box] [data-preview]')).toHaveTextContent('com.joined')
    // Drawn as the app it will be, under the name being typed.
    const zone = document.querySelector('[data-drop-box]')!
    expect(zone).toHaveTextContent('Joined (Android)')
    fireEvent.change(screen.getByLabelText('New app name'), { target: { value: 'Joined Droid' } })
    expect(zone).toHaveTextContent('Joined Droid')
    expect(handle.parentElement).toHaveClass('opacity-40')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(document.activeElement).toBe(handle))
    expect(document.querySelector('[data-drop-box]')).toBeNull()
  })

  // A merge waits the same way: closed early, the row would sit in its old app until the list moved it.
  it('keeps a merge\'s dialog and its landed row until the list shows the row moved', async () => {
    await renderCard()
    const handle = grip(/Move com\.joined \(Android\)/)
    handle.focus()
    await press(handle, 'Space', ' ')
    await press(handle, 'ArrowDown', 'ArrowDown')
    await press(handle, 'ArrowDown', 'ArrowDown')
    await press(handle, 'Space', ' ')
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Merge into Other?')

    const refetch = hold()
    serverApps = [app(1, 'Joined', 'org.joined', null), app(2, 'Other', 'org.other', 'com.joined')]
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }))
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(screen.getByRole('button', { name: 'Merging…' })).toBeInTheDocument()
    expect(document.querySelector('[data-app-id="2"] [data-preview]')).toHaveTextContent('com.joined')

    refetch.release()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(document.querySelector('[data-preview]')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actions for Other' })))
  })

  it('will not split under an empty name', async () => {
    await renderCard()
    await dropIntoNewApp()
    fireEvent.change(await screen.findByLabelText('New app name'), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: 'Split' })).toBeDisabled()
  })
})
