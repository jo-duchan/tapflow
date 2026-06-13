// #4 — CORS 출처 제한.
// 기존엔 모든 응답에 `Access-Control-Allow-Origin: *` + `Allow-Headers: Authorization`을 줘서,
// PAT(Authorization 헤더)를 cross-origin 스크립트에서 사용할 수 있었다. 허용 출처 allowlist에
// 든 origin만 에코하고, 그 외에는 CORS 헤더를 부여하지 않는다(브라우저가 cross-origin을 차단).
// same-origin 요청과 비-브라우저(CLI/서버-서버, Origin 헤더 없음)는 CORS와 무관하게 그대로 동작한다.
export function resolveCorsHeaders(
  origin: string | undefined,
  allowedOrigins: Set<string>,
): Record<string, string> | null {
  if (!origin) return null
  if (!allowedOrigins.has(origin)) return null
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  }
}
