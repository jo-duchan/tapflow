import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sources } from './sourceFiles.mjs'

const root = join(import.meta.dirname, '../..')
const agentCore = readFileSync(join(root, 'packages/agent-core/src/types.ts'), 'utf8')

function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s*\/\/.*$/gm, '')
}

function stringLiterals(text) {
  return [...text.matchAll(/(['"])([^\r\n]*?)\1/g)].map((match) => match[2])
}

// The union is derived from this array (#700), so the array is where the spelling lives. The
// non-empty assertion is the guard on the guard: the union's right-hand side used to be parsed, and
// once it became `(typeof …)[number]` it would have parsed to an empty set — every consumer then
// "undeclared", or with a looser matcher, nothing checked at all.
function agentCapabilities(text) {
  const match = withoutComments(text).match(/export const KNOWN_AGENT_CAPABILITIES\s*=\s*\[([\s\S]*?)\]/)
  expect(match, 'KNOWN_AGENT_CAPABILITIES did not parse').not.toBeNull()
  const declared = new Set(stringLiterals(match[1]))
  expect(declared.size, 'KNOWN_AGENT_CAPABILITIES parsed to nothing').toBeGreaterThan(0)
  return declared
}

// This spelling floor only sees direct literal checks: aliases, constants, and template literals are
// deliberately outside its scope, so it is not a whole-program capability-consumer fence.
const capabilityCheck = /\b(?:agentCapabilities|(?:\w+\??\.)?capabilities)\??\.includes\(\s*(['"])([^\r\n]*?)\1\s*\)/g

function capabilityChecks(text) {
  return [...withoutComments(text).matchAll(capabilityCheck)].map((match) => match[2])
}

function dashboardCapabilityConsumers() {
  const consumers = []

  for (const file of sources('packages/dashboard')) {
    for (const capability of capabilityChecks(readFileSync(join(root, file), 'utf8'))) {
      consumers.push({ file, capability })
    }
  }

  return consumers
}

describe('dashboard capability consumers', () => {
  it('reports undeclared double-quoted capability checks', () => {
    const declared = agentCapabilities(agentCore)
    const consumers = capabilityChecks('agentCapabilities.includes("undeclared-capability")')

    expect(consumers).toEqual(['undeclared-capability'])
    expect(consumers.filter((capability) => !declared.has(capability))).toEqual(['undeclared-capability'])
  })

  it('only checks capabilities AgentCapability declares', () => {
    const declared = agentCapabilities(agentCore)
    const consumers = dashboardCapabilityConsumers()

    // An empty list proves no consumer was scanned, not that consumers agree. The cardinality also
    // catches a narrower matcher that loses one of the current selector/viewer forms.
    expect(consumers).toHaveLength(4)

    const unknown = consumers.filter(({ capability }) => !declared.has(capability))
    expect(unknown).toEqual([])
  })
})
