import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { AddAppDialog } from '@/components/app-center/AddAppDialog'
import * as queries from '@/lib/queries'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

describe('AddAppDialog — toast feedback', () => {
  beforeEach(() => vi.clearAllMocks())

  async function openAndFill() {
    await userEvent.click(screen.getByRole('button', { name: /add app/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'My App')
    await userEvent.type(screen.getByLabelText(/bundle id/i), 'com.example.app')
  }

  it('TC16: 앱 생성 성공 시 toast.success("App created") 호출', async () => {
    vi.spyOn(queries, 'createApp').mockResolvedValue({ id: 1 })
    render(<AddAppDialog onSuccess={vi.fn()} canWrite />)
    await openAndFill()
    await userEvent.click(screen.getByRole('button', { name: /create app/i }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('App created'))
  })

  it('TC18: 네트워크 throw 시 toast.error 호출, success는 미호출', async () => {
    vi.spyOn(queries, 'createApp').mockRejectedValue(new Error('Network'))
    render(<AddAppDialog onSuccess={vi.fn()} canWrite />)
    await openAndFill()
    await userEvent.click(screen.getByRole('button', { name: /create app/i }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to create app — check your network'),
    )
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('TC17: 중복(409) 에러는 폼 안에 표시하고 toast는 미호출', async () => {
    vi.spyOn(queries, 'createApp').mockResolvedValue({
      error: 'App with this bundle ID and platform already exists',
    })
    render(<AddAppDialog onSuccess={vi.fn()} canWrite />)
    await openAndFill()
    await userEvent.click(screen.getByRole('button', { name: /create app/i }))
    await waitFor(() =>
      screen.getByText('App with this bundle ID and platform already exists'),
    )
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })
})

// Viewer keeps the button — named, focusable, not disabled — and pressing it explains the refusal
// instead of opening a form whose submit the relay would refuse.
// Mutation: drop the `!canWrite` branch → the dialog opens and the toast is never raised.
describe('AddAppDialog — Viewer', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows a toast on click, opens no dialog and sends nothing', async () => {
    const createApp = vi.spyOn(queries, 'createApp')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    render(<AddAppDialog onSuccess={vi.fn()} canWrite={false} />)
    const button = screen.getByRole('button', { name: /add app/i })
    expect(button).not.toBeDisabled()
    await userEvent.click(button)
    expect(toast.error).toHaveBeenCalledWith("Viewers can't add apps. Ask an Admin for QA or Developer access.")
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(createApp).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('is reachable and pressable from the keyboard', async () => {
    render(<AddAppDialog onSuccess={vi.fn()} canWrite={false} />)
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /add app/i }))
    await userEvent.keyboard('{Enter}')
    expect(toast.error).toHaveBeenCalledTimes(1)
  })
})
