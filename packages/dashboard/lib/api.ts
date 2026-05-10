const BASE = import.meta.env.VITE_API_BASE ?? ''

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ data: T | null; status: number; error?: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body != null ? JSON.stringify(body) : undefined,
  })

  if (res.status === 204) return { data: null, status: 204 }

  const json = await res.json().catch(() => null)
  if (!res.ok) return { data: null, status: res.status, error: json?.error ?? 'Request failed' }
  return { data: json as T, status: res.status }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),

  upload: async <T>(path: string, formData: FormData): Promise<{ data: T | null; status: number; error?: string }> => {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    })
    if (res.status === 204) return { data: null, status: 204 }
    const json = await res.json().catch(() => null)
    if (!res.ok) return { data: null, status: res.status, error: json?.error ?? 'Upload failed' }
    return { data: json as T, status: res.status }
  },

  uploadPatch: async <T>(path: string, formData: FormData): Promise<{ data: T | null; status: number; error?: string }> => {
    const res = await fetch(`${BASE}${path}`, {
      method: 'PATCH',
      credentials: 'include',
      body: formData,
    })
    if (res.status === 204) return { data: null, status: 204 }
    const json = await res.json().catch(() => null)
    if (!res.ok) return { data: null, status: res.status, error: json?.error ?? 'Upload failed' }
    return { data: json as T, status: res.status }
  },
}
