const PALETTE_SIZE = 6;

function hashName(name: string): number {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  return Math.abs(hash);
}

export function avatarColors(name: string): { bg: string; fg: string } {
  const i = (hashName(name) % PALETTE_SIZE) + 1;
  return {
    bg: `hsl(var(--avatar-${i}-bg))`,
    fg: `hsl(var(--avatar-${i}-fg))`,
  };
}

type Props = {
  name: string;
  avatarUrl?: string | null;
  size?: number;
};

export function UserAvatar({ name, avatarUrl, size = 28 }: Props) {
  const letter = (name?.[0] ?? '?').toUpperCase();
  const style = { width: size, height: size, borderRadius: '50%', flexShrink: 0 } as const;

  if (avatarUrl) {
    return <img src={avatarUrl} alt={name} style={{ ...style, objectFit: 'cover' }} />;
  }

  const { bg, fg } = avatarColors(name);
  return (
    <span
      style={{
        ...style,
        background: bg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: fg,
        fontSize: size * 0.42,
        fontWeight: 600,
        userSelect: 'none',
      }}
    >
      {letter}
    </span>
  );
}
