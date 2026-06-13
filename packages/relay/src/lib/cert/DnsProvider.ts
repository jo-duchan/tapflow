// DNS-01 챌린지 solver 추상화 (issue #232).
// 사용자 자기 DNS 계정 자격증명으로 동작한다(BYO). v1: Cloudflare 우선, Route53 등 후속.
// 자격증명(API 토큰)은 config 파일이 아니라 env에서 읽어 비밀 누출을 막는다.

/**
 * ACME DNS-01 발급 중 _acme-challenge TXT를 설정/정리하는 계약.
 * 와일드카드가 아닌 단일 이름 발급(LAN BYO)에선 fqdn = 사용자 서브도메인.
 */
export interface DnsProvider {
  readonly name: string
  /** `_acme-challenge.<fqdn>` 에 value TXT 설정(멱등). */
  setTxtRecord(fqdn: string, value: string): Promise<void>
  /** 발급 후 챌린지 TXT 정리. */
  removeTxtRecord(fqdn: string, value: string): Promise<void>
  /**
   * (선택) 서브도메인 A/AAAA 레코드를 LAN IP로 매핑 — wizard 자동화용.
   * 미구현 공급자는 생략하고 wizard가 수동 안내로 폴백한다.
   */
  upsertAddressRecord?(fqdn: string, ip: string): Promise<void>
}
