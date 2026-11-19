import type { CSSProperties, ReactNode } from 'react'
import type { GrammarState, HighlighterCore } from 'shiki/core'

// shadcn's highlighter for CodeBlock (registry `use-highlighted-code`), with the languages this dashboard shows. Every
// part of Shiki is imported on first use, never statically: a page that only draws a CodeBlock of plain text, and the
// QA page's first load, carry none of it. The JavaScript regex engine, so no WASM loads.
const languages = {
  bash: () => import('shiki/langs/shellscript.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
}

const aliases: Record<string, keyof typeof languages> = { sh: 'bash', shell: 'bash', yml: 'yaml' }

let highlighter: Promise<HighlighterCore> | undefined

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(([core, engine]) =>
    core.createHighlighterCore({
      themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
      langs: [],
      engine: engine.createJavaScriptRegexEngine({ forgiving: true }),
    }))
  return highlighter
}

function languageOf(language: string): keyof typeof languages | null {
  const name = language.toLowerCase()
  return name in languages ? name as keyof typeof languages : aliases[name] ?? null
}

export interface Highlighter {
  /** One node per line, and the grammar state after the last, to continue from. */
  highlight(code: string, state?: GrammarState): { lines: ReactNode[]; state: GrammarState | undefined }
}

/** A highlighter for `language`, or null for one not listed. */
export async function loadHighlighter(language: string): Promise<Highlighter | null> {
  const lang = languageOf(language)
  if (!lang) return null
  const shiki = await getHighlighter()
  if (!shiki.getLoadedLanguages().includes(lang)) await shiki.loadLanguage(languages[lang]())
  return {
    highlight(code, state) {
      const tokens = shiki.codeToTokens(code, {
        lang, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false, grammarState: state,
      }).tokens
      return {
        lines: tokens.map((line) => line.map((token, i) => (
          <span key={i} style={token.htmlStyle as CSSProperties} className="text-[var(--shiki-light)] dark:text-[var(--shiki-dark)]">
            {token.content}
          </span>
        ))),
        state: shiki.getLastGrammarState(tokens),
      }
    },
  }
}
