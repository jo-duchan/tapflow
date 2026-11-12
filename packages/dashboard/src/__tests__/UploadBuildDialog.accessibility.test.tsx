import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UploadBuildDialog } from '@/components/UploadBuildDialog'

function fileInput() {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('File input missing')
  return input
}

describe('UploadBuildDialog file and status accessibility', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function open() {
    const user = userEvent.setup()
    const onSuccess = vi.fn()
    render(<UploadBuildDialog onSuccess={onSuccess} appId={7} canWrite />)
    await user.tab()
    await user.keyboard('{Enter}')
    return { user, onSuccess }
  }

  it.each(['{Enter}', ' '])('chooses and uploads a file using %j', async (key) => {
    const { user, onSuccess } = await open()
    const picker = screen.getByRole('button', { name: 'File' })
    expect(picker).toHaveFocus()
    expect(picker).toHaveAccessibleDescription('Click or drag to upload')
    const input = fileInput()
    const chooseFile = vi.spyOn(input, 'click')

    await user.keyboard(key)
    expect(chooseFile).toHaveBeenCalledOnce()
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    const file = new File(['build'], 'app.apk', { type: 'application/octet-stream' })
    await user.upload(input, file)
    expect(picker).toHaveAccessibleDescription('app.apk')
    // jsdom has no native chooser to return focus to its trigger.
    picker.focus()
    await user.keyboard(key)
    expect(chooseFile).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.tab()
    expect(screen.getByRole('combobox', { name: 'Status (optional)' })).toHaveFocus()
    await user.tab()
    await user.tab()
    await user.tab()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Upload' })).toHaveFocus()
    await user.keyboard('{Enter}')

    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce())
    const form = fetchMock.mock.calls[0]![1].body as FormData
    expect(form.get('file')).toBe(file)
    expect(form.get('app_id')).toBe('7')
  })

  it('names the Status field and submits a keyboard-selected status', async () => {
    const { user, onSuccess } = await open()
    const file = new File(['build'], 'app.apk')
    await user.upload(fileInput(), file)
    await user.tab()
    const status = screen.getByRole('combobox', { name: 'Status (optional)' })
    expect(status).toHaveFocus()
    await user.keyboard('{Enter}{ArrowDown}{Enter}')
    expect(status).toHaveTextContent('Backlog')
    await user.click(screen.getByRole('button', { name: 'Upload' }))

    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce())
    const form = fetchMock.mock.calls[0]![1].body as FormData
    expect(form.get('status')).toBe('Backlog')
    expect(form.get('file')).toBe(file)
  })

  it('activates the File and Status controls from their visible labels', async () => {
    const { user } = await open()
    const status = screen.getByRole('combobox', { name: 'Status (optional)' })
    await user.click(screen.getByText('Status', { exact: false, selector: 'label' }))
    expect(status).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{Escape}')
    expect(status).toHaveFocus()
    const chooseFile = vi.spyOn(fileInput(), 'click')
    await user.click(screen.getByText('File', { selector: 'label' }))
    expect(screen.getByRole('button', { name: 'File' })).toHaveFocus()
    expect(chooseFile).toHaveBeenCalledOnce()
  })

  it('uploads a file dropped on the file chooser', async () => {
    const { user, onSuccess } = await open()
    const file = new File(['build'], 'dropped.apk')
    fireEvent.drop(screen.getByRole('button', { name: 'File' }), { dataTransfer: { files: [file] } })
    expect(screen.getByRole('button', { name: 'File' })).toHaveAccessibleDescription('dropped.apk')
    await user.click(screen.getByRole('button', { name: 'Upload' }))

    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce())
    const form = fetchMock.mock.calls[0]![1].body as FormData
    expect(form.get('file')).toBe(file)
  })
})
