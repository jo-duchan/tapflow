import type { RelayServer } from '../RelayServer.js'
import { startCertRenewal, startAddressPublisher } from './cert/index.js'
import type { CertProvider } from './cert/index.js'
import type { TapflowConfig } from './config.js'

/**
 * Starts the TLS background tasks shared by every relay entry point (server.ts, `tapflow relay start`,
 * `tapflow start`): periodic cert renewal (pushed into the live server via updateTlsContext) and, for
 * byo-api-token, the LAN-IP → A-record publisher. Returns one combined stop() to call on shutdown.
 *
 * Callers keep what differs: cert acquisition (createCertProvider/ensureCert), the cert-disabled log,
 * and the banner/host display. This bundles only the otherwise-copy-pasted renewal + publish wiring.
 */
export function startTlsBackgroundTasks(
  provider: CertProvider,
  server: RelayServer,
  tlsConfig: TapflowConfig['tls'],
): () => void {
  const stopRenewal = startCertRenewal(provider, { onRenew: (m) => server.updateTlsContext({ cert: m.cert, key: m.key }) })
  // byo-api-token: publish the relay's LAN IP to the domain's A record so teammates just open the URL.
  const stopPublish =
    tlsConfig?.mode === 'byo-api-token' && tlsConfig.publishAddress !== false
      ? startAddressPublisher(tlsConfig)
      : null
  return () => {
    stopRenewal?.()
    stopPublish?.()
  }
}
