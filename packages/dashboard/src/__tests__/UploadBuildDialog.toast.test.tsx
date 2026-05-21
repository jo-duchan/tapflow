import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { UploadBuildDialog } from '@/components/upload-build-dialog'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    promise: vi.fn((p: Promise<unknown>) => { p.catch(() => {}); return p }),
  },
}))

function makeFile(name = 'app.apk') {
  return new File(['content'], name, { type: 'application/octet-stream' })
}

async function openAndAttachFile(file: File) {
  await userEvent.click(screen.getByRole('button', { name: /upload build/i }))
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  await userEvent.upload(input, file)
}

describe('UploadBuildDialog — toast.promise feedback', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it('TC19: 업로드 시작 시 toast.promise 호출', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    render(<UploadBuildDialog onSuccess={vi.fn()} />)
    await openAndAttachFile(makeFile())
    await userEvent.click(screen.getByRole('button', { name: /^upload$/i }))
    await waitFor(() => expect(toast.promise).toHaveBeenCalled())
  })

  it('TC19: 업로드 시작과 동시에 다이얼로그가 닫힘', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    render(<UploadBuildDialog onSuccess={vi.fn()} />)
    await openAndAttachFile(makeFile())
    await userEvent.click(screen.getByRole('button', { name: /^upload$/i }))
    await waitFor(() => expect(toast.promise).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('TC20: 서버 에러(res.ok=false)는 toast.promise의 promise가 reject됨', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Unsupported file format' }),
      }),
    )
    render(<UploadBuildDialog onSuccess={vi.fn()} />)
    await openAndAttachFile(makeFile())
    await userEvent.click(screen.getByRole('button', { name: /^upload$/i }))
    await waitFor(() => expect(toast.promise).toHaveBeenCalled())
    const promiseArg = (toast.promise as ReturnType<typeof vi.fn>).mock.calls[0][0] as Promise<unknown>
    const errMsg = await promiseArg.catch((e: Error) => e.message)
    expect(errMsg).toBe('Unsupported file format')
  })
})
