import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// shadcn's CodeBlock (registry `radix-nova/code-block`), carried to this package's Tailwind 3: its v4-only utilities
// (`in-data-*`, `text-(--x)`, `min-h-lh`, `scroll-fade-*`) are written as the arbitrary variants and values they stand
// for. Highlighting is separate and optional (`useHighlightedCode`), so a block of plain text costs no Shiki.

const codeBlockVariants = cva(
  'group/code-block relative flex w-full min-w-0 flex-col overflow-hidden rounded-lg text-sm data-[size=sm]:text-xs '
    + 'has-[>[data-slot=code-block-content]:focus-visible]:ring-2 has-[>[data-slot=code-block-content]:focus-visible]:ring-ring/50',
  {
    variants: {
      variant: {
        default: 'border border-input bg-background text-foreground has-[>[data-slot=code-block-content]:focus-visible]:border-ring',
        destructive: 'border border-destructive/30 text-destructive',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

function CodeBlock({ className, variant = 'default', size = 'default', ...props }: React.ComponentProps<'div'>
  & VariantProps<typeof codeBlockVariants> & { size?: 'default' | 'sm' }) {
  return (
    <div data-slot="code-block" data-variant={variant} data-size={size}
      className={cn(codeBlockVariants({ variant }), className)} {...props} />
  )
}

function CodeBlockHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="code-block-header" className={cn(
      'flex min-w-0 shrink-0 items-center gap-2 px-3 pt-3 text-muted-foreground group-data-[size=sm]/code-block:px-2.5 group-data-[size=sm]/code-block:pt-2.5',
      className,
    )} {...props} />
  )
}

function CodeBlockTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="code-block-title" className={cn(
      'min-w-0 truncate font-sans text-sm font-medium text-foreground group-data-[size=sm]/code-block:text-xs [&_svg]:pointer-events-none [&_svg]:me-1.5 [&_svg]:inline-block [&_svg]:size-3.5 [&_svg]:align-middle',
      className,
    )} {...props} />
  )
}

function CodeBlockActions({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="code-block-actions" className={cn('-my-1 -me-1.5 ms-auto flex shrink-0 items-center gap-1', className)} {...props} />
}

/**
 * Copies `value`, and says so for a moment. `copy` is the page's own (a plain-HTTP page has no clipboard API, and the
 * caller may say so somewhere else); without one it is the browser's.
 */
function CodeBlockCopyButton({ value, copy, className, onClick, ...props }: React.ComponentProps<typeof Button> & {
  value: string
  copy?: (text: string) => Promise<boolean>
}) {
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    if (!copied) return
    const timeout = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timeout)
  }, [copied])
  const write = copy ?? ((text: string) => navigator.clipboard.writeText(text).then(() => true, () => false))
  return (
    <>
      <Button
        data-slot="code-block-copy-button" data-copied={copied || undefined} variant="ghost" size="icon"
        aria-label={copied ? 'Copied' : 'Copy'} className={cn('size-7', className)}
        onClick={(event) => { onClick?.(event); void write(value).then((ok) => { if (ok) setCopied(true) }) }}
        {...props}
      >
        {copied ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}
      </Button>
      <span aria-live="polite" className="sr-only">{copied ? 'Copied' : ''}</span>
    </>
  )
}

function CodeBlockContent({ className, children, style, wrap = false, lineNumbers = false, startLine = 1, ...props }:
  React.ComponentProps<'pre'> & { wrap?: boolean; lineNumbers?: boolean; startLine?: number }) {
  return (
    <pre
      // A named block is a region: `aria-label` on a bare `pre` is not announced, and it takes focus to scroll.
      role={props['aria-label'] || props['aria-labelledby'] ? 'region' : undefined}
      data-slot="code-block-content" data-wrap={wrap || undefined} data-numbered={lineNumbers || undefined} dir="ltr"
      tabIndex={0} style={{ counterReset: `line ${startLine - 1}`, ...style }}
      className={cn(
        'min-h-0 min-w-0 overflow-auto px-3 py-3 text-start font-mono leading-relaxed outline-none',
        'group-data-[size=sm]/code-block:px-2.5 group-data-[size=sm]/code-block:py-2.5',
        'group-has-[[data-slot=code-block-header]]/code-block:pt-2',
        'data-[wrap]:whitespace-pre-wrap data-[wrap]:break-words',
        className,
      )}
      {...props}
    >
      <code data-slot="code-block-code" className="grid min-w-max content-start [[data-numbered]_&]:grid-cols-[auto_1fr] [[data-wrap]_&]:min-w-0">
        {lineNumbers && typeof children === 'string'
          ? children.replace(/\n$/, '').split('\n').map((line, i) => <CodeBlockLine key={i}>{line}</CodeBlockLine>)
          : children}
      </code>
    </pre>
  )
}

const codeBlockLineVariants = cva(
  'relative -mx-3 block min-h-[1lh] px-3 group-data-[size=sm]/code-block:-mx-2.5 group-data-[size=sm]/code-block:px-2.5 '
    + 'before:min-w-6 before:text-end before:text-muted-foreground '
    + '[[data-numbered]_&]:col-span-2 [[data-numbered]_&]:grid [[data-numbered]_&]:grid-cols-[subgrid] [[data-numbered]_&]:gap-x-3 '
    + '[[data-numbered]_&]:[counter-increment:line] [[data-numbered]_&]:before:select-none [[data-numbered]_&]:before:content-[counter(line)]',
  {
    variants: {
      variant: {
        default: '',
        added: 'bg-muted',
        removed: 'bg-destructive/10',
        highlighted: 'bg-muted',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

function CodeBlockLine({ className, variant = 'default', children, ...props }: React.ComponentProps<'span'>
  & VariantProps<typeof codeBlockLineVariants>) {
  // An empty line holds a newline so copying a selection keeps blank lines.
  const empty = children === undefined || children === null || children === '' || (Array.isArray(children) && children.length === 0)
  return (
    <span data-slot="code-block-line" data-variant={variant} className={cn(codeBlockLineVariants({ variant }), className)} {...props}>
      <span data-slot="code-block-line-content" className="min-w-0">{empty ? '\n' : children}</span>
    </span>
  )
}

export { CodeBlock, CodeBlockHeader, CodeBlockTitle, CodeBlockActions, CodeBlockCopyButton, CodeBlockContent, CodeBlockLine }
