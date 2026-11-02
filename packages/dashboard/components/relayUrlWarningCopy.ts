export const publicUrlWarningTitle = 'This relay has no address teammates can open.'
export const publicUrlWarningBody = {
  beforeRelayUrl: 'Set ',
  relayUrl: 'TAPFLOW_RELAY_URL',
  afterRelayUrl: ' to a reachable address or configure a working tunnel public URL.',
} as const
export const publicUrlWarningAnnouncement = `${publicUrlWarningTitle} ${publicUrlWarningBody.beforeRelayUrl}${publicUrlWarningBody.relayUrl}${publicUrlWarningBody.afterRelayUrl}`

export const agentUrlWarningTitle = 'This relay has no address agents can use.'
export const agentUrlWarningBody = {
  beforeRelayUrl: 'Set ',
  relayUrl: 'TAPFLOW_RELAY_URL',
  afterRelayUrl: ' to an address the agent Mac can reach. A tunnel URL is for teammate browser links; agents connect directly to the relay.',
} as const
export const agentUrlWarningAnnouncement = `${agentUrlWarningTitle} ${agentUrlWarningBody.beforeRelayUrl}${agentUrlWarningBody.relayUrl}${agentUrlWarningBody.afterRelayUrl}`
