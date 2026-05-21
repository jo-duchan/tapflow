# dashboard — CLAUDE.md

> Common rules: [CLAUDE.md](../../CLAUDE.md) | Full index: [INDEX.md](../../INDEX.md)

---

## Design Reference

Before any design or frontend work, read **[DESIGN.md](./DESIGN.md)** and follow the color tokens, typography, and elevation rules defined there.

## WHAT

React SPA QA dashboard: provides the simulator viewer, bug reports, and team invite screens.
**No standalone deployment** — bundled to `dist/` via `vite build`, then copied to the relay package's `public/` directory and served directly by the relay server.

### App Center Structure

`/app-center` route. Left app list sidebar + center Release Accordion + Build cards.

- **App sidebar**: `GET /api/v1/apps` → selecting an app manages state via `?appId=N` URL parameter.
- **Release Accordion**: `GET /api/v1/builds?app_id=N` → grouped by `version_name` (`groupByRelease()`). No dedicated `releases` table — UI grouping uses `version_name` metadata.
- **Build card**: shows `build_number`, `platform`, `status_label`, uploader, `uploaded_at`. Inline status dropdown. **"Start QA" CTA** → `/app-center/build?id={build_id}`.
- **Upload**: `UploadBuildDialog` — iOS `.app.zip` / Android `.apk`. `version_name` / `build_number` are auto-extracted from plist, so no manual input fields.

## HOW

- **Stack**: Vite + React 19 + React Router v7 + Shadcn/Tailwind + next-themes
- **Structure**: `src/` — app entry, router, pages; `components/` — shared components; `hooks/` — custom hooks; `lib/` — utils, types, API client
- **Routing**: `BrowserRouter`-based. `/login` and `/invite` are public. Everything else is protected by `DashboardLayout` via `useAuth` (redirects to `/login`).
- **Auth**: Session confirmed via `GET /api/v1/auth/me`. HttpOnly cookie (not readable from JS).
- **Streaming**: set `binaryType = 'arraybuffer'` in `useRelay`, branch on `e.data instanceof ArrayBuffer` for binary frames.
- **Dev server proxy**: `vite.config.ts` proxies `/api` and `/uploads` → `http://localhost:4000`.
- **Build order**: dashboard first → relay second (`agent-core → dashboard → relay`).

## Testing

- `pnpm test` is always run foreground (terminal). **Never run vitest as a background process** — worker forks accumulate as zombies and exhaust CPU/RAM.
- If a test appears to hang, Ctrl+C immediately and diagnose. Do not re-run without fixing the root cause.
- Components that combine multiple `useEffect` + `react-hook-form` `Controller` + `useWatch` (e.g. `DefaultSettings`) can hang in jsdom under full render. `vitest.config.ts` has `testTimeout: 10000` as a safety net — a timeout failure means the test setup needs fixing, not more retries.
- When mocking `fetch` in a component that fires multiple concurrent `useEffect` fetches (e.g. `GET /api/v1/settings` + `GET /api/v1/apps`), use URL-based dispatch (`mockImplementation((url) => {...})`) instead of `mockResolvedValueOnce` chains — call order is non-deterministic.

## HOW NOT

- Do not reintroduce the `next` package.
- Do not run as a standalone server — the relay serves it.
- Do not call the Agent directly from the dashboard — always go through the relay.
- Do not put platform-specific conditionals (`if platform === 'ios'`) in UI components.
- Do not send session recording data to external storage.

---

## Compound

### WebSocket Binary Frame Reception Pattern

**When**: handling binary stream frames in `useRelay`

**How**:
```typescript
// useRelay.ts — inside connect()
socket.binaryType = 'arraybuffer'
socket.onmessage = (e) => {
  if (e.data instanceof ArrayBuffer) {
    onBinaryFrameRef.current?.(e.data)
    return
  }
  try { onMessageRef.current(JSON.parse(e.data)) } catch { }
}

// IOSViewer.tsx — frame rendering
createImageBitmap(new Blob([data], { type: 'image/jpeg' }))
  .then((bitmap) => {
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()  // release GPU texture memory
  })
```

**Why**: Without `binaryType = 'arraybuffer'`, `e.data` becomes a `Blob` requiring extra async handling. Omitting `bitmap.close()` leaks GPU texture memory every frame. `createImageBitmap` is CPU-based decoding — no hardware acceleration unlike a WebRTC Video Track.
