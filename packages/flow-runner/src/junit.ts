import type { FlowResult } from './engine.js'

function esc(s: string): string {
  return s
    // control characters (except \t \n \r) are illegal in XML 1.0 and break strict CI parsers
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function stepLog(result: FlowResult): string {
  return result.steps
    .map((s) => {
      if (s.status === 'passed') return `✓ ${s.name} (${s.durationMs}ms)`
      if (s.status === 'failed') return `✗ ${s.name} (${s.durationMs}ms): ${s.message ?? ''}`
      return `- ${s.name} (skipped)`
    })
    .join('\n')
}

export function toJUnitXml(results: FlowResult[]): string {
  const failures = results.filter((r) => r.status === 'failed').length
  const totalSec = (results.reduce((acc, r) => acc + r.durationMs, 0) / 1000).toFixed(3)

  const cases = results
    .map((r) => {
      const attrs = `name="${esc(r.name)}" classname="${esc(r.file ?? r.name)}" time="${(r.durationMs / 1000).toFixed(3)}"`
      if (r.status === 'passed') {
        return `    <testcase ${attrs}>\n      <system-out>${esc(stepLog(r))}</system-out>\n    </testcase>`
      }
      return (
        `    <testcase ${attrs}>\n` +
        `      <failure message="${esc(r.failureMessage ?? 'flow failed')}">${esc(stepLog(r))}</failure>\n` +
        `    </testcase>`
      )
    })
    .join('\n')

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<testsuites tests="${results.length}" failures="${failures}" time="${totalSec}">\n` +
    `  <testsuite name="tapflow-flows" tests="${results.length}" failures="${failures}" time="${totalSec}">\n` +
    `${cases}\n` +
    '  </testsuite>\n' +
    '</testsuites>\n'
  )
}
