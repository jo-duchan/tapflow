# ios-agent — CLAUDE.md

> 공통 규칙: [CLAUDE.md](../../CLAUDE.md) | 전체 인덱스: [INDEX.md](../../INDEX.md)

---

## WHAT

`IOSAgent`: `xcrun simctl`로 iOS 시뮬레이터를 제어하고, WebDriverAgent로 터치를 인젝션하며, MJPEG(Phase 1) / WebRTC(Phase 2)로 화면을 스트리밍한다.

## HOW

- macOS에서만 실행됨을 가정한다. 비 macOS 환경에서는 명확한 오류를 던진다.
- xcrun/WDA 호출은 모두 래핑 함수로 분리해 테스트 시 목(mock) 교체가 가능하게 한다.
- Phase 1은 MJPEG 스크린샷 루프로 구현한다 (~10fps). WebRTC는 Phase 2 이후다.

## HOW NOT

- `xcrun` 명령을 비즈니스 로직과 인라인으로 섞지 않는다.
- WDA가 없는 환경에서 무한 대기하지 않는다 — 타임아웃을 설정한다.
- `DeviceAgent` 인터페이스에 없는 iOS 전용 메서드를 public API로 노출하지 않는다.
