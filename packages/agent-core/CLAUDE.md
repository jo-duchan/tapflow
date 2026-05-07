# agent-core — CLAUDE.md

> 공통 규칙: [CLAUDE.md](../../CLAUDE.md) | 전체 인덱스: [INDEX.md](../../INDEX.md)

---

## WHAT

`DeviceAgent` 인터페이스와 `AgentRegistry`를 정의한다.
플랫폼 구현체(ios-agent, android-agent)가 의존하는 유일한 계약이다.

## HOW

- 인터페이스에는 플랫폼 중립 메서드만 포함한다: `boot`, `shutdown`, `installApp`, `launchApp`, `screenshot`, `stream`, `tap`, `swipe`, `type`, `listDevices`.
- `AgentRegistry`는 `register(platform, AgentClass)` / `get(platform)` 두 메서드만 노출한다.
- 인터페이스 변경은 모든 구현체 패키지의 테스트 통과를 확인 후 머지한다.

## HOW NOT

- 플랫폼 특화 타입(xcrun 응답, ADB 출력 등)을 이 패키지에 넣지 않는다.
- 런타임 의존성을 추가하지 않는다 (순수 타입 + 레지스트리만).
