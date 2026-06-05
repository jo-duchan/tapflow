---
description: 릴리즈 절차 — 버전 추천부터 릴리즈 PR까지 (changesets, 가이드형)
model: claude-opus-4-8
---

다음 npm 릴리즈를 준비한다. 인자로 bump 레벨(`major`/`minor`/`patch`)을 줄 수 있고, 없으면 근거를 모아 직접 추천한다: **$ARGUMENTS**

**가이드형으로 진행한다** — 각 판단 지점에서 멈춰 사용자와 합의하고, 위험 단계 전에 확인받는다. 자동으로 push/merge/publish 하지 않는다.

## 1. 현황 수집 (evidence-based)

- 현재 버전: publish 패키지들의 `package.json`
- `git log v{latest}..HEAD --oneline`(머지 포함/제외 각각) — feat / fix / perf / breaking 분류
- 열린 PR: `gh pr list`
- 대기 중인 changeset: `.changeset/*.md`
- `.changeset/config.json`의 `fixed` / `ignore` 그룹 재확인

## 2. bump 레벨 추천 → 사용자 합의

- SemVer 0.x 기준: feat 추가 = **minor**, 버그픽스만 = **patch**, 1.0 승격은 별도 논의(안정성 선언이라 아껴둔다).
- 이번 사이클의 **테마 한 줄**을 뽑는다(릴리즈노트 제목이 된다).
- 프로토콜/인터페이스 변경 커밋이 있으면 → 3번 호환성 검증.
- **추천 버전을 제시하고 합의를 받은 뒤** 진행한다.

## 3. 호환성 검증 (프로토콜/인터페이스 변경 시에만)

- 변경 범주: WebSocket envelope/메시지, 공개 API 시그니처, CLI 커맨드·플래그, DB 스키마.
- 있으면 **새 e2e를 돌리지 말고**, 해당 PR의 기존 검증 + 단위테스트의 backward-compat 케이스를 코드로 확인한다.
  (예: `agent-core/envelope.test.ts`의 `backward compatible` 케이스, `ios-agent` `codec negotiation`의 version-skew 폴백 케이스)
- backward-compat면 minor로 충분 → 릴리즈노트에 "호환 유지" 근거 인용.
- 아니면 사용자에게 보고하고 릴리즈노트 상단에 경고 + breaking 여부 재논의.

## 4. 브랜치

- `git checkout main && git pull origin main` — 항상 최신 main에서 시작.
- `git checkout -b release/vX.Y.Z`

## 5. changeset 작성/보완

- 이번 테마를 담은 changeset이 없으면 추가한다(기본 changelog 생성기는 changeset 본문만 CHANGELOG에 넣으므로, 핵심 변경이 changeset에 없으면 누락된다).
- **fixed 그룹**(`tapflow`·`agent-core`·`ios-agent`·`android-agent`·`relay`)은 멤버 하나만 명시해도 5개가 동반 bump되지만, CHANGELOG 본문은 명시된 패키지에만 들어간다 → 본문이 필요한 핵심 패키지를 모두 명시한다.

## 6. 버전 적용

- `pnpm changeset version`
- fixed 그룹 5개가 함께 `X.Y.Z`로 올랐는지, changeset 파일이 소비됐는지 확인.

## 7. 이 레포 전용 수동 단계 (놓치기 가장 쉬움)

- **mcp-server**: `.changeset` `ignore` 대상이라 자동 bump 안 됨 → `package.json` version을 **`X.Y.Z-experimental.1`** 로 수동 변경(experimental dist-tag, graduation 전까지 수동).
- **루트 `CHANGELOG.md`**: changeset 관리 밖(Keep a Changelog 수동) → `[Unreleased]`를 `[X.Y.Z] - YYYY-MM-DD`(오늘 날짜)로 승격하고 Added/Changed/Fixed를 채운다.
  - **하단 compare 링크도 함께 갱신**(놓치기 쉬움): `[Unreleased]`를 `vX.Y.Z...HEAD`로 바꾸고, `[X.Y.Z]: .../compare/v{직전}...vX.Y.Z` 링크를 새로 추가한다. 직전 릴리즈 링크가 빠져 있으면 이번에 함께 메운다.
- **dashboard**: private + `ignore` → 건드리지 않는다.

## 8. 검증

- lint / typecheck(pre-commit 훅이 잡지만 미리 확인 가능).
- 내부 의존성이 `workspace:*`라 lockfile 변경은 없어야 정상 — 변경이 생겼으면 의심한다.

## 9. 커밋 → STOP

- `chore: release vX.Y.Z — {테마}` 로 커밋.
- **여기서 멈추고 push/PR 진행 여부를 사용자에게 확인한다.**

## 10. push + PR (확인 후에만)

- `git push -u origin release/vX.Y.Z`
- `gh pr create --base main` — 본문에 버전 표 + 릴리즈노트 + 호환성 근거.
- **PR을 머지하지 않는다.** 머지는 사용자 몫.

## 11. 머지 후 — 태그 push로 발행 트리거 (놓치면 발행이 안 됨)

`.github/workflows/release.yml`은 **`vX.Y.Z` 태그 push로만** 발동한다. **main 머지만으로는 npm 발행이 일어나지 않는다** — 머지 후 태그를 직접 달아야 한다.

- PR 머지를 확인한 뒤, **머지 커밋에** 태그를 단다(이전 릴리즈와 동일한 방식):
  `git fetch origin main && git tag vX.Y.Z <머지 커밋 SHA>`
- **STOP** — 태그 push는 즉시 npm 발행을 유발하는 되돌리기 어려운 작업이다. 사용자 확인 후 진행한다.
- `git push origin vX.Y.Z`
- 워크플로우가 처리하는 것: `pnpm build` → `changeset publish`(stable 5종) → `mcp-server`는 experimental dist-tag로 별도 publish → GitHub Release 생성.
- npm 인증은 **GitHub OIDC(trusted publishing)** 로 동작한다 — NPM_TOKEN 등 별도 토큰이 필요 없다.
- 발행 확인: Actions의 Release 워크플로우 `success`, `npm view tapflow version`, GitHub Releases 페이지.
