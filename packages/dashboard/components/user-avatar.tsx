const PALETTE = [
  '#4f46e5', '#0891b2', '#059669', '#d97706',
  '#dc2626', '#7c3aed', '#db2777', '#0284c7',
]

function colorFromName(name: string): string {
  let hash = 0
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff
  return PALETTE[Math.abs(hash) % PALETTE.length]
}

type Props = {
  name: string
  avatarUrl?: string | null
  size?: number
}

export function UserAvatar({ name, avatarUrl, size = 28 }: Props) {
  const letter = (name?.[0] ?? '?').toUpperCase()
  const style = { width: size, height: size, borderRadius: '50%', flexShrink: 0 } as const

  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={name}
        style={{ ...style, objectFit: 'cover' }}
      />
    )
  }

  return (
    <span
      style={{
        ...style,
        background: colorFromName(name),
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        fontSize: size * 0.42,
        fontWeight: 600,
        userSelect: 'none',
      }}
    >
      {letter}
    </span>
  )
}
