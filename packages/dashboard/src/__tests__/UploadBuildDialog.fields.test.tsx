import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UploadBuildDialog } from '@/components/UploadBuildDialog'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), promise: vi.fn((p: Promise<unknown>) => { p.catch(() => {}); return p }) },
}))

// #1084: a label, and a version and build number that override the build file's, sent with the upload.

async function open() {
  await userEvent.click(screen.getByRole('button', { name: /upload build/i }))
  await userEvent.upload(document.querySelector('input[type="file"]') as HTMLInputElement, new File(['x'], 'app.apk'))
}

function sentFields(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
  const form = (fetchMock.mock.calls[0]![1] as RequestInit).body as FormData
  return Object.fromEntries([...form.entries()].filter(([k]) => k !== 'file').map(([k, v]) => [k, String(v)]))
}

describe('UploadBuildDialog — label and version override', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the override folded away, and sends what was filled in, trimmed', async () => {
    render(<UploadBuildDialog onSuccess={vi.fn()} canWrite />)
    await open()
    expect(screen.queryByLabelText('Version')).toBeNull()
    await userEvent.type(screen.getByLabelText(/^Label/), ' staging ')
    const toggle = screen.getByRole('button', { name: 'Override version' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await userEvent.type(screen.getByLabelText('Version'), '2.0.0')
    await userEvent.click(screen.getByRole('button', { name: /^upload$/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // The build number was left empty, so the file's is used: it is not sent at all.
    expect(sentFields(fetchMock)).toEqual({ label: 'staging', version_name: '2.0.0' })
  })

  it('sends none of them when nothing was filled in', async () => {
    render(<UploadBuildDialog onSuccess={vi.fn()} canWrite />)
    await open()
    await userEvent.click(screen.getByRole('button', { name: /^upload$/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(sentFields(fetchMock)).toEqual({})
  })

  it('starts empty and folded each time it opens', async () => {
    render(<UploadBuildDialog onSuccess={vi.fn()} canWrite />)
    await open()
    await userEvent.type(screen.getByLabelText(/^Label/), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Override version' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await open()
    expect(screen.getByLabelText(/^Label/)).toHaveValue('')
    expect(screen.queryByLabelText('Version')).toBeNull()
  })

  it('holds each field to the relay\'s bound', async () => {
    render(<UploadBuildDialog onSuccess={vi.fn()} canWrite />)
    await open()
    expect(screen.getByLabelText(/^Label/)).toHaveAttribute('maxLength', '100')
  })
})
