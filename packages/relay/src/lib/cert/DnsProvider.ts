// ACME DNS-01 solver 계약. 토큰은 config가 아니라 env에서 읽는다(비밀 누출 방지).
export interface DnsProvider {
  readonly name: string
  // 구현이 _acme-challenge.<fqdn> 위치로 prefix를 붙인다(멱등).
  setTxtRecord(fqdn: string, value: string): Promise<void>
  removeTxtRecord(fqdn: string, value: string): Promise<void>
  // 선택: 서브도메인 A/AAAA를 LAN IP로 매핑(미구현 공급자는 생략).
  upsertAddressRecord?(fqdn: string, ip: string): Promise<void>
}
