import { X509Certificate } from 'crypto'

/** PEM 인증서에서 notAfter(만료 시각)를 파싱한다. 잘못된 PEM이면 throw. */
export function parseCertNotAfter(certPem: string): Date {
  return new Date(new X509Certificate(certPem).validTo)
}
