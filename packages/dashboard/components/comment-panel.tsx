import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Link2, ImagePlus } from 'lucide-react'
import type { Comment } from '@/lib/types'
import { UserAvatar } from '@/components/user-avatar'

// SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" (UTC, no timezone marker).
// Normalize to unambiguous ISO 8601 UTC so all browsers parse it correctly.
function parseUTCDate(ts: string): Date {
  if (/[Zz]|[+-]\d{2}/.test(ts)) return new Date(ts)
  return new Date(ts.replace(' ', 'T') + 'Z')
}

const MAX_SIZE_BYTES = 5 * 1024 * 1024
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp']

type Props = { buildId: number }

export function CommentPanel({ buildId }: Props) {
  const [comments, setComments] = useState<Comment[]>([])
  const [body, setBody] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [fileError, setFileError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const commentRefs = useRef<Record<number, HTMLDivElement | null>>({})

  function load() {
    fetch(`/api/v1/comments?build_id=${buildId}`, { credentials: 'include' })
      .then((r) => r.ok ? r.json() : [])
      .then(setComments)
  }

  useEffect(() => { load() }, [buildId])

  useEffect(() => {
    const hash = window.location.hash
    if (!hash.startsWith('#comment-')) return
    const id = Number(hash.replace('#comment-', ''))
    const el = commentRefs.current[id]
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth' })
    el.classList.add('ring-2', 'ring-ring', 'ring-offset-2')
    setTimeout(() => el.classList.remove('ring-2', 'ring-ring', 'ring-offset-2'), 1500)
  }, [comments])

  function copyLink(id: number) {
    const url = `${location.origin}${location.pathname}${location.search}#comment-${id}`
    navigator.clipboard.writeText(url).catch(() => {})
  }

  function handleFileChange(f: File) {
    setFileError('')
    if (!ALLOWED_TYPES.includes(f.type)) { setFileError('Only png, jpg, webp allowed'); return }
    if (f.size > MAX_SIZE_BYTES) { setFileError('Max 5MB'); return }
    setFile(f)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!body.trim() && !file) return
    setSubmitting(true)
    const form = new FormData()
    form.append('build_id', String(buildId))
    form.append('body', body)
    if (file) form.append('attachment', file)
    const res = await fetch('/api/v1/comments', { method: 'POST', credentials: 'include', body: form })
    if (res.ok) { setBody(''); setFile(null); load() }
    setSubmitting(false)
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <ScrollArea className="flex-1 rounded-md border p-3">
        {comments.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No comments yet.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {comments.map((c) => (
              <div
                key={c.id}
                id={`comment-${c.id}`}
                ref={(el) => { commentRefs.current[c.id] = el }}
                className="flex flex-col gap-1 rounded-md transition-all"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <UserAvatar name={c.author} avatarUrl={c.authorAvatarUrl} size={20} />
                    <span className="text-xs font-medium">{c.author}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-muted-foreground">
                      {parseUTCDate(c.created_at).toLocaleString()}
                    </span>
                    <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => copyLink(c.id)}>
                      <Link2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{c.body}</p>
                {c.attachments.map((a) => (
                  <a key={a.id} href={a.file_path} target="_blank" rel="noreferrer">
                    <img src={a.file_path} alt="attachment" className="max-h-48 rounded border object-contain" />
                  </a>
                ))}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      <Separator />

      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <Textarea
          placeholder="Leave a comment…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-16 resize-none text-sm"
        />
        {file && <p className="text-xs text-muted-foreground">{file.name}</p>}
        {fileError && <p className="text-xs text-destructive">{fileError}</p>}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => fileRef.current?.click()}
          >
            <ImagePlus className="h-4 w-4" />
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileChange(f) }}
          />
          <div className="flex-1" />
          <Button type="submit" size="sm" disabled={submitting || (!body.trim() && !file)}>
            {submitting ? 'Posting…' : 'Post'}
          </Button>
        </div>
      </form>
    </div>
  )
}
