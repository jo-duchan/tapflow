export const APP_LOG_BUFFER_LIMIT = 64 * 1024

export function appendAppLogText(previous: string, next: string): string {
  const combined = previous + next
  if (combined.length <= APP_LOG_BUFFER_LIMIT) return combined
  let start = combined.length - APP_LOG_BUFFER_LIMIT
  const firstRetained = combined.charCodeAt(start)
  if (firstRetained >= 0xdc00 && firstRetained <= 0xdfff) start++
  return combined.slice(start)
}
