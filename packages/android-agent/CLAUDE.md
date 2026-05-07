# android-agent — CLAUDE.md

> 공통 규칙: [CLAUDE.md](../../CLAUDE.md) | 전체 인덱스: [INDEX.md](../../INDEX.md)

---

## WHAT

`AndroidAgent`: ADB를 통해 Android 에뮬레이터를 제어하고, `adb exec-out screencap`으로 화면을 스트리밍한다. Linux/Mac/Windows 모두 지원.

## HOW

- ADB 명령은 래핑 함수로 분리해 테스트 시 목(mock) 교체가 가능하게 한다.
- 에뮬레이터 부팅 시 `adb wait-for-device`로 준비 완료를 확인한 뒤 다음 단계로 진행한다.
- 클라우드 Linux 환경에서는 `-gpu swiftshader_indirect`를 기본으로 사용한다.

## HOW NOT

- ADB 경로를 하드코딩하지 않는다 — 환경 변수 또는 설정으로 주입한다.
- 에뮬레이터 부팅 완료 확인 없이 ADB 명령을 실행하지 않는다.
- scrcpy 기반 스트리밍은 Phase 4 이후에만 도입한다.
