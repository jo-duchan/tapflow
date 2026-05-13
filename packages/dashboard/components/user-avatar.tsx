const PALETTE = [
  {
    bg: '#FF6476',
    text: '#6E0000',
  },
  {
    bg: '#FF7138',
    text: '#6A0000',
  },
  {
    bg: '#FFD200',
    text: '#723C00',
  },
  {
    bg: '#00C866',
    text: '#003100',
  },
  {
    bg: '#68ACFF',
    text: '#00166F',
  },
  {
    bg: '#CF8DFF',
    text: '#34006D',
  },
];

function colorFromName(name: string): { bg: string; text: string } {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  return PALETTE[Math.abs(hash) % PALETTE.length];
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

  const { bg, text } = colorFromName(name);
  return (
    <span
      style={{
        ...style,
        background: bg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: text,
        fontSize: size * 0.42,
        fontWeight: 600,
        userSelect: 'none',
      }}
    >
      {letter}
    </span>
  );
}
