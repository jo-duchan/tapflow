import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'

interface Props {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}

export function SearchInput({ value, onChange, placeholder, className }: Props) {
  return (
    <div className="relative">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
      <Input
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`h-8 pl-8 ${className ?? 'w-48'}`}
      />
    </div>
  )
}
