---
"tapflow": minor
---

feat(cli): `tapflow start`가 `tapflow.config.json`의 tunnel 설정을 읽어 공개 URL을 배너에 출력합니다.

기존에는 `tapflow relay start`에서만 터널(Tailscale/rathole)을 기동했습니다. 이제 로컬 올인원 명령인 `tapflow start`도 동일하게 터널을 띄우고, Tailscale MagicDNS 호스트명(또는 tailnet IP)을 자동 감지해 배너에 `Public :` URL을 표시합니다. 터널 기동 로직은 `lib/tunnel-runner.ts`로 공통화했습니다.
