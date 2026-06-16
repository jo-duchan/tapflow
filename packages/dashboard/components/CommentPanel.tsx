import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Link2, ImagePlus, ArrowUp } from 'lucide-react'
import { toast } from 'sonner'
import type { Comment } from '@/lib/types'
import { UserAvatar } from '@/components/UserAvatar'

// SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" (UTC, no timezone marker).
// Normalize to unambiguous ISO 8601 UTC so all browsers parse it correctly.
function parseUTCDate(ts: string): Date {
  if (/[Zz]|[+-]\d{2}/.test(ts)) return new Date(ts)
  return new Date(ts.replace(' ', 'T') + 'Z')
}

function groupByDate(comments: Comment[]) {
  const map = new Map<string, Comment[]>()
  for (const c of comments) {
    const key = parseUTCDate(c.created_at).toDateString()
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(c)
  }
  const today = new Date().toDateString()
  const yesterday = new Date(Date.now() - 86_400_000).toDateString()
  return Array.from(map.entries()).map(([key, items]) => {
    let label: string
    if (key === today) label = 'Today'
    else if (key === yesterday) label = 'Yesterday'
    else {
      const d = new Date(key)
      label = d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
      })
    }
    return { label, items }
  })
}

function timeOnly(ts: string): string {
  return parseUTCDate(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
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
    const isDark = document.documentElement.classList.contains('dark')
    el.style.backgroundColor = isDark ? 'rgb(0 112 243 / 0.18)' : '#d3e5ff'
    setTimeout(() => { el.style.backgroundColor = '' }, 2000)
  }, [comments])

  function copyLink(id: number) {
    const url = `${location.origin}${location.pathname}${location.search}#comment-${id}`
    navigator.clipboard.writeText(url)
      .then(() => toast.success('Link copied'))
      .catch(() => toast.error('Could not copy link'))
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

  const groups = groupByDate(comments)

  return (
    <div className="flex h-full flex-col gap-3 px-1">
      <ScrollArea className="flex-1 rounded-md border">
        <div className="p-3">
          {comments.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No comments yet.</p>
          ) : (
            <div className="flex flex-col">
              {groups.map(({ label, items }) => (
                <div key={label}>
                  {/* Date divider */}
                  <div className="flex items-center gap-2 py-3">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-[11px] font-medium text-muted-foreground px-1 select-none">
                      {label}
                    </span>
                    <div className="h-px flex-1 bg-border" />
                  </div>

                  <div className="flex flex-col gap-4">
                    {items.map((c) => (
                      <div
                        key={c.id}
                        id={`comment-${c.id}`}
                        ref={(el) => { commentRefs.current[c.id] = el }}
                        className="group flex gap-2.5 rounded-md px-2 py-1.5 transition-all"
                      >
                        <div className="mt-0.5 shrink-0">
                          <UserAvatar name={c.author} avatarUrl={c.authorAvatarUrl} size={28} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-semibold leading-none">{c.author}</span>
                            <span className="text-[11px] text-muted-foreground leading-none">
                              {timeOnly(c.created_at)}
                            </span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-4 w-4 ml-0.5 opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity"
                              onClick={() => copyLink(c.id)}
                            >
                              <Link2 className="h-3 w-3" />
                            </Button>
                          </div>
                          <p className="text-sm leading-relaxed whitespace-pre-wrap mt-1">{c.body}</p>
                          {c.attachments.map((a) => (
                            <a key={a.id} href={a.file_path} target="_blank" rel="noreferrer" className="mt-1.5 block">
                              <img src={a.file_path} alt="attachment" className="max-h-48 rounded border object-contain" />
                            </a>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="pb-1">
      <form onSubmit={handleSubmit}>
        <div className="rounded-xl border border-input bg-background ring-offset-background transition-shadow focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
          <Textarea
            placeholder="Leave a comment…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="min-h-16 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 text-sm"
          />
          {(file || fileError) && (
            <div className="px-3 -mt-1 pb-1">
              {file && <p className="text-xs text-muted-foreground">{file.name}</p>}
              {fileError && <p className="text-xs text-destructive">{fileError}</p>}
            </div>
          )}
          <div className="flex items-center gap-2 px-2 py-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
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
            <Button
              type="submit"
              size="icon"
              className="h-7 w-7 rounded-full"
              disabled={submitting || (!body.trim() && !file)}
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </form>
      </div>
    </div>
  )
}
