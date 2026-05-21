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
    render(<AddAppDialog onSuccess={vi.fn()} />)
    await openAndFill()
    await userEvent.click(screen.getByRole('button', { name: /create app/i }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('App created'))
  })

  it('TC18: 네트워크 throw 시 toast.error 호출, success는 미호출', async () => {
    vi.spyOn(queries, 'createApp').mockRejectedValue(new Error('Network'))
    render(<AddAppDialog onSuccess={vi.fn()} />)
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
    render(<AddAppDialog onSuccess={vi.fn()} />)
    await openAndFill()
    await userEvent.click(screen.getByRole('button', { name: /create app/i }))
    await waitFor(() =>
      screen.getByText('App with this bundle ID and platform already exists'),
    )
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })
})
