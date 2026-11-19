import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useEffect } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { Runs } from '@/src/pages/Runs'
import { RunDetail } from '@/src/pages/RunDetail'
import { failureBadge, pollWhileRunning, runOutcomeText, runSourceLabel, RUNS_POLL_MS } from '@/lib/runs'
import type { RunDetail as Run, RunListItem } from '@/lib/types'
import { withQuery } from './withQuery'

function listItem(overrides: Partial<RunListItem> = {}): RunListItem {
  return {
    id: 'r1', status: 'passed', finishedBy: 'client', failureKind: null, errorMessage: null, exitCode: 0,
    isCi: true, ci: { provider: 'github', branch: 'main', commit: 'abcdef123456', jobUrl: 'https://github.com/o/r/actions/runs/1' },
    serviceTier: null,
    deviceReset: null,
    build: { id: 7, appName: 'Coffee', versionName: '1.2.0', buildNumber: '42', platform: 'ios' },
    createdBy: 'ci', flowsTotal: 2, createdAt: '2026-10-11 01:00:00', finishedAt: '2026-10-11 01:01:05',
    flowsPassed: 2, flowsFailed: 0, flowsSkipped: 0,
    ...overrides,
  }
}

/** The relay as the page sees it: every GET it made, and an answer chosen by path. */
function stubRelay(answer: (url: string) => Response) {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return answer(url) }))
  return urls
}

/** Where the router is, so a test can read the filters the page put in the URL. */
const probe = { location: '' }
function LocationProbe() {
  const l = useLocation()
  useEffect(() => { probe.location = `${l.pathname}${l.search}` })
  return null
}

function renderAt(path: string) {
  return render(withQuery(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/automation/runs" element={<Runs />} />
        <Route path="/automation/runs/:runId" element={<RunDetail />} />
      </Routes>
      {/* What the sidebar's Runs item is: a link to the same route with no filters. */}
      <Link to="/automation/runs">Sidebar Runs</Link>
      <LocationProbe />
    </MemoryRouter>,
  ))
}

afterEach(() => vi.unstubAllGlobals())

describe('Runs list', () => {
  beforeEach(() => { probe.location = '' })

  it('shows CI runs by default, each row a link to the run', async () => {
    const urls = stubRelay(() => Response.json({ items: [listItem()], nextCursor: null, prevCursor: null }))
    renderAt('/automation/runs')
    const link = await screen.findByRole('link', { name: /^Coffee 1\.2\.0 · build 42, Passed, / })
    expect(link.getAttribute('href')).toBe('/automation/runs/r1')
    expect(urls[0]).toBe('/api/v1/runs?ci=1&limit=25')
    expect(screen.getByText('GitHub Actions · main')).toBeTruthy()
    expect(link.closest('tr')?.textContent).toContain('2/2')
  })

  // Mutation: drop the skipped count, and a run that skipped two of three reads as one that lost them.
  it('names the flows a run skipped beside the passed count', async () => {
    stubRelay(() => Response.json({ items: [listItem({ flowsTotal: 3, flowsPassed: 1, flowsSkipped: 2 }), listItem({ id: 'r2' })], nextCursor: null, prevCursor: null }))
    renderAt('/automation/runs')
    const rows = (await screen.findAllByRole('link', { name: /^Coffee 1\.2\.0 · build 42, Passed, / })).map((l) => l.closest('tr')?.textContent)
    expect(rows[0]).toContain('1/3(2 skipped)')
    expect(rows[1]).not.toContain('skipped')
  })

  it('says how many devices a run shared, and nothing for a run on one', async () => {
    const devices = (n: number) => ({ requested: true, booted: true as const, devices: Array.from({ length: n }, (_, i) => ({ sessionId: `s${i}` })) })
    stubRelay(() => Response.json({ items: [listItem({ deviceReset: devices(3) }), listItem({ id: 'r2', deviceReset: devices(1) })], nextCursor: null, prevCursor: null }))
    renderAt('/automation/runs')
    const rows = (await screen.findAllByRole('link', { name: /^Coffee 1\.2\.0 · build 42, Passed, / })).map((l) => l.closest('tr')?.textContent)
    expect(rows[0]).toContain('2/2on 3 devices')
    expect(rows[1]).not.toContain('devices')
  })

  it('tells a run the environment failed apart from one the app failed, in the row and its name', async () => {
    stubRelay(() => Response.json({
      items: [
        listItem({ id: 'r1', status: 'failed', failureKind: 'product', exitCode: 1 }),
        listItem({ id: 'r2', status: 'failed', failureKind: 'environment', exitCode: 2, build: { id: 8, appName: 'Tea', versionName: '2.0.0', buildNumber: '9', platform: 'android' } }),
      ],
      nextCursor: null, prevCursor: null,
    }))
    renderAt('/automation/runs')
    expect(await screen.findByRole('link', { name: /^Coffee 1\.2\.0 · build 42, Failed, / })).toBeTruthy()
    const env = screen.getByRole('link', { name: /^Tea 2\.0\.0 · build 9, Environment problem, / })
    expect(env.closest('tr')?.textContent).toContain('Environment problem')
  })

  it('opens a run from anywhere on its row, and in a new tab with Cmd', async () => {
    const item = listItem({ status: 'failed', flowsPassed: 1, flowsFailed: 1 })
    stubRelay((url) => url.startsWith('/api/v1/runs/r1')
      ? Response.json({ ...item, flows: [], watchSessionId: null })
      : Response.json({ items: [item], nextCursor: null, prevCursor: null }))
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    renderAt('/automation/runs')
    const link = await screen.findByRole('link', { name: /, Failed, / })
    const row = link.closest('tr')!
    expect(row.textContent).toContain('1/2')
    // The status column says how it ended; the cell does not repeat it.
    expect(row.textContent).not.toContain('failed')
    fireEvent.click(screen.getByText('GitHub Actions · main'), { metaKey: true })
    expect(open).toHaveBeenCalledWith('/automation/runs/r1', '_blank', 'noopener')
    // A drag that selected text is a copy, not a click on the row.
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'main' } as Selection)
    await userEvent.click(screen.getByText('GitHub Actions · main'))
    expect(probe.location).toBe('/automation/runs')
    selection.mockRestore()
    await userEvent.click(screen.getByText('GitHub Actions · main'))
    await waitFor(() => expect(probe.location).toBe('/automation/runs/r1'))
  })

  it('asks for local runs, and for every run, when the source changes', async () => {
    const urls = stubRelay(() => Response.json({ items: [], nextCursor: null, prevCursor: null }))
    renderAt('/automation/runs')
    await screen.findByText(/No CI runs yet/)
    await userEvent.click(screen.getByRole('tab', { name: 'Local' }))
    await waitFor(() => expect(urls).toContain('/api/v1/runs?ci=0&limit=25'))
    await userEvent.click(screen.getByRole('tab', { name: 'All' }))
    await waitFor(() => expect(urls).toContain('/api/v1/runs?limit=25'))
    expect(probe.location).toBe('/automation/runs?source=all')
  })

  it('filters by the build in the URL, names it, and can let it go', async () => {
    const urls = stubRelay(() => Response.json({ items: [listItem()], nextCursor: null, prevCursor: null }))
    renderAt('/automation/runs?source=all&build=7')
    await screen.findByRole('link', { name: /, Passed, / })
    expect(urls[0]).toBe('/api/v1/runs?build=7&limit=25')
    await userEvent.click(screen.getByRole('button', { name: 'Show runs of every build, not only Coffee 1.2.0 · build 42' }))
    await waitFor(() => expect(probe.location).toBe('/automation/runs?source=all'))
  })

  it('searches by flow name after a pause, not on every key', async () => {
    const urls = stubRelay(() => Response.json({ items: [], nextCursor: null, prevCursor: null }))
    renderAt('/automation/runs')
    await screen.findByText(/No CI runs yet/)
    await userEvent.type(screen.getByRole('textbox', { name: 'Flow name' }), 'login')
    await waitFor(() => expect(urls).toContain('/api/v1/runs?ci=1&flow=login&limit=25'))
    expect(urls.filter((u) => u.includes('flow='))).toEqual(['/api/v1/runs?ci=1&flow=login&limit=25'])
  })

  it('clears the flow box with the rest when a link to the bare page is followed', async () => {
    stubRelay(() => Response.json({ items: [], nextCursor: null, prevCursor: null }))
    renderAt('/automation/runs?flow=login&status=failed')
    const box = await screen.findByRole('textbox', { name: 'Flow name' })
    expect((box as HTMLInputElement).value).toBe('login')
    await userEvent.click(screen.getByRole('link', { name: 'Sidebar Runs' }))
    await waitFor(() => expect((box as HTMLInputElement).value).toBe(''))
    // Past the debounce: the box must not have written the old flow back.
    await new Promise((r) => setTimeout(r, 450))
    expect(probe.location).toBe('/automation/runs')
  })

  it('holds a failed filter as the failure while it is tried again, not the previous filter\'s rows', async () => {
    let answerRetry: (r: Response) => void = () => {}
    let failedOnce = false
    stubRelay((url) => {
      if (!url.includes('status=failed')) return Response.json({ items: [listItem()], nextCursor: null, prevCursor: null })
      if (!failedOnce) { failedOnce = true; return new Response('', { status: 500 }) }
      return new Promise<Response>((resolve) => { answerRetry = resolve }) as unknown as Response
    })
    renderAt('/automation/runs')
    await screen.findByRole('link', { name: /, Passed, / })
    await userEvent.click(screen.getByRole('combobox', { name: 'Status' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Failed' }))
    await screen.findByText("Couldn't load flow runs.")
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText("Couldn't load flow runs.")).toBeTruthy()
    expect(screen.queryByRole('link', { name: /, Passed, / })).toBeNull()
    answerRetry(Response.json({ items: [], nextCursor: null, prevCursor: null }))
    await screen.findByText('No runs match these filters.')
  })

  it('says a failure is a failure, with a way to try again', async () => {
    let fail = true
    stubRelay(() => fail ? new Response('', { status: 500 }) : Response.json({ items: [listItem()], nextCursor: null, prevCursor: null }))
    renderAt('/automation/runs')
    await screen.findByText("Couldn't load flow runs.")
    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('link', { name: /, Passed, / })
  })

  it('pages by cursor: Older, Newer, and the URL holds the page', async () => {
    const urls = stubRelay((url) => url.includes('before=41')
      ? Response.json({ items: [listItem({ id: 'r0', status: 'failed', flowsPassed: 1, flowsFailed: 1 })], nextCursor: null, prevCursor: '40' })
      : Response.json({ items: [listItem()], nextCursor: '41', prevCursor: null }))
    renderAt('/automation/runs')
    await screen.findByRole('link', { name: /, Passed, / })
    const newer = screen.getByRole('button', { name: 'Newer' })
    expect(newer.getAttribute('aria-disabled')).toBe('true')
    await userEvent.click(screen.getByRole('button', { name: 'Older' }))
    await screen.findByRole('link', { name: /, Failed, / })
    expect(urls).toContain('/api/v1/runs?ci=1&before=41&limit=25')
    expect(probe.location).toBe('/automation/runs?before=41')
    // Still focused and still a button at the oldest page, only unavailable.
    expect(screen.getByRole('button', { name: 'Older' }).getAttribute('aria-disabled')).toBe('true')
    await userEvent.click(screen.getByRole('button', { name: 'Newer' }))
    await waitFor(() => expect(urls).toContain('/api/v1/runs?ci=1&after=40&limit=25'))
    expect(probe.location).toBe('/automation/runs?after=40')
  })

  it('keeps a way back from a page that came back empty', async () => {
    stubRelay((url) => url.includes('before=')
      ? Response.json({ items: [], nextCursor: null, prevCursor: null })
      : Response.json({ items: [listItem()], nextCursor: null, prevCursor: null }))
    renderAt('/automation/runs?before=5')
    await screen.findByText(/No runs on this page any more/)
    const newer = screen.getByRole('button', { name: 'Newer' })
    expect(newer.getAttribute('aria-disabled')).toBe('false')
    await userEvent.click(newer)
    await waitFor(() => expect(probe.location).toBe('/automation/runs'))
    await screen.findByRole('link', { name: /, Passed, / })
  })

  it('holds the page buttons while the next page loads', async () => {
    let answerOlder: (r: Response) => void = () => {}
    stubRelay((url) => url.includes('before=41')
      ? new Promise<Response>((resolve) => { answerOlder = resolve }) as unknown as Response
      : Response.json({ items: [listItem()], nextCursor: '41', prevCursor: null }))
    renderAt('/automation/runs')
    await userEvent.click(await screen.findByRole('button', { name: 'Older' }))
    expect(screen.getByRole('button', { name: 'Older' }).getAttribute('aria-disabled')).toBe('true')
    answerOlder(Response.json({ items: [listItem({ id: 'r0', status: 'failed' })], nextCursor: null, prevCursor: '40' }))
    await screen.findByRole('link', { name: /, Failed, / })
  })

  it('starts from the newest page when a filter changes', async () => {
    stubRelay(() => Response.json({ items: [listItem()], nextCursor: '41', prevCursor: '50' }))
    renderAt('/automation/runs?before=60')
    await screen.findByRole('link', { name: /, Passed, / })
    await userEvent.click(screen.getByRole('tab', { name: 'All' }))
    await waitFor(() => expect(probe.location).toBe('/automation/runs?source=all'))
  })

  it('shows no page buttons when everything fits on one page', async () => {
    stubRelay(() => Response.json({ items: [listItem()], nextCursor: null, prevCursor: null }))
    renderAt('/automation/runs')
    await screen.findByRole('link', { name: /, Passed, / })
    expect(screen.queryByRole('navigation', { name: 'Pages of flow runs' })).toBeNull()
  })
})

describe('Run detail', () => {
  function detail(overrides: Partial<Run> = {}): Run {
    return {
      ...listItem(), watchSessionId: null,
      flows: [
        { idx: 0, name: 'login', file: 'flows/login.yaml', status: 'passed', device: { id: 'd', name: 'iPhone 16', platform: 'ios' }, failureKind: null, failureMessage: null, durationMs: 1200, steps: [], hasScreenshot: false },
        { idx: 1, name: 'checkout', file: null, status: 'not-run' },
      ],
      ...overrides,
    }
  }

  it('says which services the run asked its device to boot with, and nothing when it asked for none', async () => {
    stubRelay(() => Response.json(detail({ serviceTier: { name: 'slim', keep: ['push', 'photos'] } })))
    const { unmount } = renderAt('/automation/runs/r1')
    expect(await screen.findByText('slim, keeping push, photos')).toBeTruthy()
    unmount()
    stubRelay(() => Response.json(detail()))
    renderAt('/automation/runs/r1')
    await screen.findByRole('status')
    expect(screen.queryByText(/^Services/)).toBeNull()
  })

  it('says what the run\'s device was reset of, and nothing for a run that predates resets', async () => {
    const cases: [Run['deviceReset'], string][] = [
      [{ requested: true, booted: true, cold: false, report: { done: ['keychain'], failed: [] } }, 'reset, already running'],
      [{ requested: true, booted: true, cold: true, report: { done: ['keychain'], failed: ['location', 'pasteboard'] } }, 'reset except location, pasteboard'],
      // Nothing done is not a reset, whether something failed or there was nothing to do.
      [{ requested: true, booted: true, cold: true, report: { done: [], failed: ['keychain'] } }, 'reset failed: keychain'],
      [{ requested: true, booted: true, cold: true, report: { done: [], failed: [] } }, 'nothing reset'],
      [{ requested: true, booted: true, cold: true }, 'reset not confirmed'],
      [{ requested: false, booted: true }, 'not reset'],
    ]
    for (const [deviceReset, label] of cases) {
      stubRelay(() => Response.json(detail({ deviceReset })))
      const { unmount } = renderAt('/automation/runs/r1')
      expect(await screen.findByText(label)).toBeTruthy()
      unmount()
    }
    // Nothing for a run that predates resets, nor for one that never reached a device.
    for (const deviceReset of [null, { requested: true }]) {
      stubRelay(() => Response.json(detail({ deviceReset })))
      const { unmount } = renderAt('/automation/runs/r1')
      await screen.findByRole('status')
      expect(screen.queryByText(/^Device/)).toBeNull()
      unmount()
    }
  })

  it('offers to watch only while the relay says which session the runner holds', async () => {
    stubRelay(() => Response.json(detail({ status: 'running', finishedAt: null, exitCode: null, watchSessionId: 's1' })))
    const { unmount } = renderAt('/automation/runs/r1')
    const watch = await screen.findByRole('link', { name: 'Watch the device' })
    expect(watch.getAttribute('href')).toBe('/automation/sessions/s1')
    unmount()

    stubRelay(() => Response.json(detail({ status: 'running', finishedAt: null, exitCode: null, watchSessionId: null })))
    renderAt('/automation/runs/r1')
    await screen.findByText('Running. This page follows the run.')
    expect(screen.queryByRole('link', { name: 'Watch the device' })).toBeNull()
    expect(screen.getByText(/^Running for/)).toBeTruthy()
  })

  // A parallel run, shown as a CI page shows jobs: a line per device, each with its own reset and watch link.
  it('lists each device of a run on several, with its reset, the flow it is on and a link to watch it', async () => {
    stubRelay(() => Response.json(detail({
      status: 'running', finishedAt: null, exitCode: null, watchSessionId: 'sa', watchSessionIds: ['sa', 'sb'],
      deviceReset: {
        requested: true, booted: true, cold: true, report: { done: ['keychain'], failed: [] },
        devices: [
          { sessionId: 'sa', deviceName: 'iPhone A', cold: true, report: { done: ['keychain'], failed: [] } },
          { sessionId: 'sb', deviceName: 'iPhone B', cold: false, report: { done: ['keychain'], failed: ['location'] } },
          { sessionId: 'sc', deviceId: 'dev-c' },
          { sessionId: 'sd' },
        ],
      },
      flows: [
        { idx: 0, name: 'login', file: null, status: 'running', device: { id: null, name: 'iPhone B', sessionId: 'sb' } },
        { idx: 1, name: 'checkout', file: null, status: 'pending' },
      ],
    })))
    renderAt('/automation/runs/r1')
    const list = await screen.findByRole('list', { name: 'Devices' })
    const lines = [...list.querySelectorAll('li')].map((li) => li.textContent)
    expect(lines).toEqual([
      'iPhone AresetWatch',
      'iPhone Breset except location, already runningRunning loginWatch',
      'dev-creset not confirmed',
      'Device 4reset not confirmed',
    ])
    expect(screen.getByRole('link', { name: 'Watch iPhone B' }).getAttribute('href')).toBe('/automation/sessions/sb')
    expect(screen.getByText('Running on iPhone B')).toBeTruthy()
    // The header's single-device account would name one device of four.
    expect(screen.queryByRole('link', { name: 'Watch the device' })).toBeNull()
    expect(screen.queryByText((_, el) => el?.tagName === 'SPAN' && /^Device reset/.test(el.textContent ?? ''))).toBeNull()
  })

  it('keeps one device in the header, as a run always said it', async () => {
    stubRelay(() => Response.json(detail({
      status: 'running', finishedAt: null, exitCode: null, watchSessionId: 'sa', watchSessionIds: ['sa'],
      deviceReset: { requested: true, booted: true, cold: true, report: { done: ['keychain'], failed: [] }, devices: [{ sessionId: 'sa', deviceName: 'iPhone A' }] },
    })))
    renderAt('/automation/runs/r1')
    expect(await screen.findByRole('link', { name: 'Watch the device' })).toBeTruthy()
    expect(screen.getByText('reset')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Devices' })).toBeNull()
  })

  it('shows a failed flow with its message, steps and screenshot, and the flows never reached', async () => {
    stubRelay(() => Response.json(detail({
      status: 'failed', exitCode: 1, failureKind: 'product',
      flows: [
        {
          idx: 0, name: 'login', file: 'flows/login.yaml', status: 'failed', device: null, failureKind: 'product',
          failureMessage: 'no element "Pay"', durationMs: 900, hasScreenshot: true,
          steps: [
            { index: 0, name: 'launchApp', status: 'passed', durationMs: 400 },
            { index: 1, name: 'tap Pay', status: 'failed', durationMs: 500, message: 'not found within 10s' },
          ],
        },
        { idx: 1, name: 'checkout', file: null, status: 'not-run' },
      ],
    })))
    renderAt('/automation/runs/r1')
    expect(await screen.findByText('no element "Pay"')).toBeTruthy()
    expect(screen.getByText('not found within 10s')).toBeTruthy()
    const shot = screen.getByRole('img', { name: 'The screen when login failed' })
    expect(shot.getAttribute('src')).toBe('/api/v1/runs/r1/flows/0/screenshot')
    expect(screen.getByText('Not run')).toBeTruthy()
    expect(screen.getByRole('link', { name: /Open the CI run/ }).getAttribute('href')).toBe('https://github.com/o/r/actions/runs/1')
  })

  it('shows a skipped flow with why, and nothing of a run it never had', async () => {
    stubRelay(() => Response.json(detail({
      flows: [
        { idx: 0, name: 'login', file: 'flows/login.yaml', status: 'skipped', skipReason: 'app-mismatch', failureMessage: 'flow is for com.a, build 7 is com.b' },
        { idx: 1, name: 'slow', file: null, status: 'skipped', skipReason: 'tag-filter', failureMessage: 'not tagged smoke' },
      ],
    })))
    renderAt('/automation/runs/r1')
    expect(await screen.findByText('flow is for com.a, build 7 is com.b')).toBeTruthy()
    expect(screen.getByText('Skipped: another app')).toBeTruthy()
    expect(screen.getByText('Skipped: tags')).toBeTruthy()
    expect(screen.getByText('not tagged smoke')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('marks a run and a flow that failed only on the environment as such, not as the app failing', async () => {
    stubRelay(() => Response.json(detail({
      status: 'failed', exitCode: 2, failureKind: 'environment', errorMessage: 'no booted device',
      flows: [{ idx: 0, name: 'login', file: null, status: 'failed', device: null, failureKind: 'environment', failureMessage: 'agent went away', durationMs: 300, steps: [], hasScreenshot: false }],
    })))
    renderAt('/automation/runs/r1')
    await screen.findByText('agent went away')
    // One for the run, one for its flow; neither says Failed.
    expect(screen.getAllByText('Environment problem')).toHaveLength(2)
    expect(screen.queryByText('Failed')).toBeNull()
  })

  it('keeps a run with an app failure red while its environment-only flow is gray', async () => {
    stubRelay(() => Response.json(detail({
      status: 'failed', exitCode: 1, failureKind: 'product',
      flows: [
        { idx: 0, name: 'login', file: null, status: 'failed', device: null, failureKind: 'product', failureMessage: 'no element "Pay"', durationMs: 900, steps: [], hasScreenshot: false },
        { idx: 1, name: 'checkout', file: null, status: 'failed', device: null, failureKind: 'environment', failureMessage: 'agent went away', durationMs: 300, steps: [], hasScreenshot: false },
      ],
    })))
    renderAt('/automation/runs/r1')
    await screen.findByText('agent went away')
    // The run's badge and login's are both Failed; only checkout's says the environment.
    expect(screen.getAllByText('Failed')).toHaveLength(2)
    expect(screen.getAllByText('Environment problem')).toHaveLength(1)
  })

  // B2: a failed tapOn's suggestions, each in a field (selectable without a clipboard) with a copy button.
  it('offers a failed tapOn\'s suggested lines to copy, and moves to the line when there is no clipboard', async () => {
    stubRelay(() => Response.json(detail({
      status: 'failed', exitCode: 1, failureKind: 'product',
      flows: [{
        idx: 0, name: 'login', file: null, status: 'failed', device: null, failureKind: 'product', failureMessage: 'no element', durationMs: 900, hasScreenshot: false,
        steps: [
          { index: 0, name: 'launchApp', status: 'passed', durationMs: 400 },
          { index: 1, name: 'tapOn("Sign inn")', status: 'failed', durationMs: 500, message: 'no element matched "Sign inn"',
            suggestions: [{ yaml: 'tapOn: "Sign in"', element: { role: 'button', label: 'Sign in' } }] },
        ],
      }],
    })))
    renderAt('/automation/runs/r1')
    const line = await screen.findByRole('textbox', { name: 'Suggested line 1 for tapOn("Sign inn")' })
    expect((line as HTMLInputElement).value).toBe('tapOn: "Sign in"')
    expect((line as HTMLInputElement).readOnly).toBe(true)
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    fireEvent.click(screen.getByRole('button', { name: 'Copy suggested line 1' }))
    await waitFor(() => expect(document.activeElement).toBe(line))
  })

  // #1125: a passed flow whose touches were not all checked says so, since a covered row once passed that way.
  it('says a passed flow has touches that were not checked to land on their element', async () => {
    stubRelay(() => Response.json(detail({
      flows: [{ idx: 0, name: 'login', file: null, status: 'passed', device: null, failureKind: null, failureMessage: null, durationMs: 10, hasScreenshot: false,
        steps: [
          { index: 0, name: 'tapOn("Row 13")', status: 'passed', durationMs: 5, reach: 'unchecked', reachNote: 'this relay predates reach' },
          { index: 1, name: 'tapOn("Save")', status: 'passed', durationMs: 5, reach: 'verified' },
        ] }],
    })))
    renderAt('/automation/runs/r1')
    expect(await screen.findByText(/1 touch was not checked to land on its element/)).toHaveTextContent('tapOn("Row 13")')
    expect(screen.getByText(/1 touch was not checked/)).toHaveTextContent('this relay predates reach')
  })

  it('shows no suggestions where a step has none', async () => {
    stubRelay(() => Response.json(detail({
      status: 'failed', exitCode: 1, failureKind: 'product',
      flows: [{ idx: 0, name: 'login', file: null, status: 'failed', device: null, failureKind: 'product', failureMessage: 'x', durationMs: 1, hasScreenshot: false,
        steps: [{ index: 0, name: 'assertVisible("Pay")', status: 'failed', durationMs: 1, message: 'no element' }] }],
    })))
    renderAt('/automation/runs/r1')
    await screen.findByText('no element')
    expect(screen.queryByText(/Try instead/)).toBeNull()
  })

  it('shows the screen a passed flow ended on, as its evidence', async () => {
    stubRelay(() => Response.json(detail({
      flows: [{ idx: 0, name: 'login', file: null, status: 'passed', device: null, failureKind: null, failureMessage: null, durationMs: 1200, steps: [], hasScreenshot: true }],
    })))
    renderAt('/automation/runs/r1')
    const shot = await screen.findByRole('img', { name: 'The screen login ended on' })
    expect(shot.getAttribute('src')).toBe('/api/v1/runs/r1/flows/0/screenshot')
  })

  it('says a run is gone rather than failing to load', async () => {
    stubRelay(() => Response.json({ error: 'Run not found' }, { status: 404 }))
    renderAt('/automation/runs/r1')
    await screen.findByText(/This run is gone/)
  })
})

describe('run wording and polling', () => {
  it('polls only while something shown is running', () => {
    expect(pollWhileRunning(['passed', 'running'])).toBe(RUNS_POLL_MS)
    expect(pollWhileRunning(['passed', 'failed', 'aborted'])).toBe(false)
    expect(pollWhileRunning(undefined)).toBe(false)
  })

  it('draws only an app failure red', () => {
    expect(failureBadge('failed', 'product')).toEqual({ label: 'Failed', tone: 'rejected' })
    expect(failureBadge('failed', null)).toEqual({ label: 'Failed', tone: 'rejected' })
    expect(failureBadge('failed', 'environment')).toEqual({ label: 'Environment problem', tone: 'backlog' })
    // The relay writes failure_kind 'holder-lost' on a run it closes; that run is aborted, and stays Cancelled.
    expect(failureBadge('aborted', 'holder-lost')).toEqual({ label: 'Cancelled', tone: 'backlog' })
    expect(failureBadge('passed', null)).toEqual({ label: 'Passed', tone: 'done' })
  })

  it('keeps a cancel, a disconnect, an environment failure and a regression apart', () => {
    const base = listItem()
    expect(runOutcomeText({ ...base, status: 'aborted', finishedBy: 'relay' })).toBe('The flow runner disconnected before the run finished.')
    expect(runOutcomeText({ ...base, status: 'aborted', errorMessage: 'cancelled (SIGINT)' })).toBe('Cancelled (SIGINT).')
    expect(runOutcomeText({ ...base, status: 'failed', failureKind: 'environment', errorMessage: 'no booted device' })).toBe('Environment problem: no booted device')
    expect(runOutcomeText({ ...base, status: 'failed', failureKind: 'product' })).toBe('At least one flow failed on the app.')
    expect(runOutcomeText(base)).toBeNull()
  })

  it('names a local run by who ran it', () => {
    expect(runSourceLabel({ isCi: false, ci: null, createdBy: 'jo' })).toBe('Local · jo')
    expect(runSourceLabel({ isCi: true, ci: { provider: 'gitlab', branch: null, commit: null, jobUrl: null }, createdBy: 'ci' })).toBe('GitLab CI')
  })
})
