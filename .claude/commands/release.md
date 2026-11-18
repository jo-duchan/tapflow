---
description: 릴리즈 절차 — 버전 추천부터 릴리즈 PR까지 (changesets, 가이드형)
model: claude-opus-5
---

다음 npm 릴리즈를 준비한다. 인자로 bump 레벨(`major`/`minor`/`patch`)을 줄 수 있고, 없으면 근거를 모아 직접 추천한다: **$ARGUMENTS**

**가이드형으로 진행한다** — 각 판단 지점에서 멈춰 사용자와 합의하고, 위험 단계 전에 확인받는다. 자동으로 push/merge/publish 하지 않는다.

## 1. 현황 수집 (evidence-based)

- 현재 버전: publish 패키지들의 `package.json`
- `git log v{latest}..HEAD --oneline`(머지 포함/제외 각각) — feat / fix / perf / breaking 분류
- 열린 PR: `gh pr list`
- 대기 중인 changeset: `.changeset/*.md`
- **누락된 릴리즈 노트 감사**: `pnpm changeset:audit`는 마지막 태그 이후 배포 소스를 바꾼 머지에서 누락된 changeset과 루트 `CHANGELOG.md` 항목을 따로 보고한다. 릴리즈 전에 각 누락을 백필하고 changeset 본문에 `Backfills: #413`처럼 대상 PR을 새 줄로 선언한다. PR 번호가 없는 머지는 감사 결과의 `Backfills: <전체 머지 해시>` 줄을 쓴다. 루트 항목이 빠졌다면 같은 PR에서 `[Unreleased]`에 항목을 쓴다. 사용자가 볼 변화가 없다면 루트 항목 대신 `<!-- changelog: internal -->`을 표시한 백필 changeset을 쓴다.
  - 루트 항목을 뒤늦게 추가하는 PR에서는 기존 `Backfills:` 선언이 있는 changeset을 그대로 두고, 같은 대상을 새 changeset에 선언한다.
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
- **fixed 그룹**(`tapflow`·`agent-core`·`ios-agent`·`android-agent`·`relay`·`flow-runner`·`mcp-server`)은 멤버 하나만 명시해도 전체가 동반 bump되지만, CHANGELOG 본문은 명시된 패키지에만 들어간다 → 본문이 필요한 핵심 패키지를 모두 명시한다.

## 6. 버전 적용

- `pnpm changeset version`
- fixed 그룹 7개가 함께 `X.Y.Z`로 올랐는지, changeset 파일이 소비됐는지 확인.

## 7. 이 레포 전용 수동 단계 (놓치기 가장 쉬움)

- **떠도는 dist-tag 훑기**: 배포 패키지 전부의 dist-tag를 나열하고 `latest`가 **아닌** 것을 찾는다.

  ```sh
  set -o pipefail
  pkgs=$(pnpm list -r --depth -1 --json \
    | python3 -c 'import json,sys; print("\n".join(p["name"] for p in json.load(sys.stdin) if p.get("name") and not p.get("private")))')
  [ "$(printf '%s' "$pkgs" | grep -c .)" -ge 2 ] || { echo "workspace discovery returned $(printf '%s' "$pkgs" | grep -c .) package(s) — refusing to report on that"; exit 1; }
  printf '%s\n' "$pkgs" | while read -r n; do
    tags=$(npm view "$n" dist-tags --json) || { echo "npm view $n failed"; exit 1; }
    printf '%-30s %s\n' "$n" "$(printf '%s' "$tags" | tr -d '\n ')"
  done
  ```

  Two things this deliberately does **not** do, both learned by getting them wrong here:

  - **The package list is derived, not typed.** An earlier version of this step listed the nine names — in a paragraph whose whole point is that hardcoded inventories go stale. A package added after the list is written is a package this step cannot see, and a new package is exactly when a forgotten tag does damage.
  - **A failure at any stage is not silence.** Three ways this reported "clean" while checking nothing, each found the same way — by breaking it on purpose:
    - `npm view … 2>/dev/null` prints nothing and leaves the loop exiting 0, so an outage or a typo'd name reads identically to "no stray tags".
    - Without `pipefail`, `pnpm list` or the parser dying leaves the `while` with no input: zero iterations, **exit 0**. Measured.
    - `pipefail` alone still does not catch a stage that succeeds while returning nothing, so the package count is checked before anything is reported. Fewer than two published packages in this workspace means discovery broke, not that the repo shrank.

  **이 항목이 훑기인 이유**: 이전 판은 `@tapflowio/mcp-server`의 `experimental` 태그 하나를 이름으로 지목했다. 그 문단은 "1회성으로 설계한 것이 원인"이라고 스스로 진단해놓고, 특정 패키지와 태그를 박은 **또 하나의 1회성 조치**를 적었다. 결과는 예측대로였다 — 2026-08-03 v0.18.0 준비 때 그 태그는 이미 없어 항목이 no-op이었고, 대신 문서가 모르는 세 개가 살아 있었다:

  | 태그 | 가리킨 버전 | 그때 `latest`와 차이 |
  |---|---|---|
  | `tapflow@alpha` | `0.1.0-alpha.8` (2026-05-20) | 2개월, 16 minor |
  | `tapflow@next` | `0.8.1-next.0` (2026-06-11) | 6주, 9 minor |
  | `@tapflowio/relay@next` | `0.8.1-next.0` (2026-06-11) | 6주, 9 minor |

  `next`는 사람들이 관습적으로 시도하는 이름이라 `experimental`보다 나빴다. **이름을 박지 말고 매번 훑는다.**

- **판정 기준**: `latest`가 아닌 태그는 그것을 먹여주는 prerelease 스트림이 **지금도 흐르는지**만 본다. 흐르면 최신 prerelease로 당긴다. 아니면 제거한다 — `latest`와 동기화해 유지하는 것은 순수한 별칭이라 잊어버릴 거리만 늘리고, 방치하면 매 릴리즈마다 격차가 벌어진다. 제거하면 그 설치가 소리내어 실패해 사용자가 옮길 신호를 받는다. 버전 자체는 지워지지 않으므로 `pkg@1.2.3-next.0` 직접 설치는 계속 동작한다.
- 사용자에게 영향이 가므로 **실행 전 확인**을 받는다: `npm dist-tag rm <pkg> <tag>`
  - **2FA 계정에서는 이 명령이 `EOTP`로 실패한다** — 브라우저 인증이 필요해 자동화할 수 없다. 사용자에게 명령을 넘긴다.
- **루트 `CHANGELOG.md`**: changeset 관리 밖(Keep a Changelog 수동) → `[Unreleased]`를 `[X.Y.Z] - YYYY-MM-DD`(오늘 날짜)로 승격하고 Added/Changed/Fixed를 채운다.
  - **하단 compare 링크도 함께 갱신**(놓치기 쉬움): `[Unreleased]`를 `vX.Y.Z...HEAD`로 바꾸고, `[X.Y.Z]: .../compare/v{직전}...vX.Y.Z` 링크를 새로 추가한다. 직전 릴리즈 링크가 빠져 있으면 이번에 함께 메운다.
- **단계 배송이 남긴 거짓말을 훑는다** — 루트와 **패키지별 CHANGELOG 양쪽**. 여러 PR에 걸쳐 들어온 기능은
  각 PR 시점에 "아직 화면에 없다"를 `[Unreleased]`와 changeset 본문에 적어 넣는데, 승격하면 그 전부가 **한
  섹션 안에** 놓여 서로를 반박한다. 그 문장이 참이었다가 거짓이 되는 순간은 승격뿐이라, 여기가 잡을 수 있는
  유일한 지점이다.

  ```sh
  set -o pipefail
  # 버전은 타이핑하지 말고 유도한다 — `changeset version`이 방금 쓴 것과, 그 직전 태그.
  ver=$(node -p "require('./packages/cli/package.json').version")
  prev=$(git describe --tags --abbrev=0 --match 'v*' | sed 's/^v//')
  found=0
  # `$(0)`, not the usual spelling: this file is a command, and a dollar followed by a digit is
  # replaced with that argument before anyone reads it. `/release 0.28.1` turned it into `0.28.1`.
  for f in CHANGELOG.md packages/*/CHANGELOG.md; do
    sec=$(awk -v v="$ver" -v p="$prev" '$(0) ~ "^#+ \\[?" v {s=1; next} $(0) ~ "^#+ \\[?" p {s=0} s' "$f") \
      || { echo "could not read $f"; exit 1; }
    [ -n "$sec" ] || continue
    found=$((found + 1))
    printf '%s\n' "$sec" \
      | grep -nEi "\byet\b|for now|still to come|(iOS|Android) follows|when it lands|nothing (is )?visible|not on screen|no agent|nothing reads|(next|later|future) releases?|will (write|read|use|play|show|send)" \
      | sed "s|^|$f: |"
  done
  [ "$found" -ge 5 ] || { echo "only $found changelog(s) carried a $ver section — the sweep read almost nothing"; exit 1; }
  echo "swept $found changelogs for $ver (previous $prev)"
  ```

  **위 dist-tag 항목의 세 교훈이 여기에도 그대로 적용된다** — 처음 쓴 판은 셋 다 어겼고, #696에서 지적받았다.
  버전을 `0.20.0`으로 박아두면 다음 사이클에 그것을 안 고친 순간 모든 awk 범위가 비고, 파일마다 0줄을 뱉으며
  전부 "clean"으로 읽힌다. 일부러 깨뜨려 재보니 **예전 판은 어긋난 버전에도, 못 읽는 파일에도 아무것도 찍지
  않고 exit 0**이었다. 그래서 버전은 유도하고, `awk` 실패는 전파하고, 섹션을 실제로 찾은 파일 수를 세어
  바닥(5개)에 못 미치면 멈춘다. 마지막 줄이 몇 개를 읽었는지 말하는 것도 같은 이유다 — 출력이 없다는 것과
  아무것도 안 읽었다는 것은 화면에서 똑같이 생겼다.

  **`yet`은 통째로 잡고, 결과를 손으로 거른다.** 처음엔 `not yet`으로 좁게 적었고 그게 정확히 이 게이트가
  막으려던 실패를 냈다 — 네 문장 중 셋만 잡고, **가장 널리 복제된** "No agent implements it yet"을 놓쳤다.
  넓힌 `\byet\b`는 v0.20.0에서 11건을 물어오고 그중 진짜는 1건이지만, 그 1건("Nothing reads that file
  yet")은 좁은 패턴도 CodeRabbit도 못 찾은 다섯 번째였다. 나머지 10건은 "a device nobody has heard from
  yet"처럼 기기 상태를 말하는 정상 문장이다. **울타리가 아니라 바닥이고**, 비용은 문단 열 개를 읽는 것이다.

  **미래형 예고도 같은 거짓말이다.** v0.28.0에서 "the dashboard will play it in a later release"와 "will read them in
  the next releases" 네 문장이 이 패턴을 빠져나갔고, CodeRabbit이 찾았다. 같은 사이클에 그 기능이 들어오면
  승격과 함께 거짓이 되는 문장이라 `(next|later|future) release`와 `will (write|read|use|play|show|send)`를 더했다.

  **패키지별 CHANGELOG를 빼먹지 않는다.** v0.20.0 준비 때 루트만 고쳤고, CodeRabbit이 패키지 쪽에서 같은
  결함을 4건 찾았다. 이어서 훑으니 **6개 패키지에 8곳**이었다 — changeset 하나가 패키지 셋을 지목하면 같은
  본문이 셋 모두에 복제되기 때문이다. changeset은 이미 소비돼 사라졌으므로, 고칠 수 있는 곳은 생성된 파일뿐이다.
- **dashboard**: private + `ignore` → 건드리지 않는다.

## 8. 검증

- lint / typecheck(pre-commit 훅이 잡지만 미리 확인 가능).
- 내부 의존성이 `workspace:*`라 lockfile 변경은 없어야 정상 — 변경이 생겼으면 의심한다.
- **수동 E2E 패스**: `pnpm e2e:plan`으로 이번 릴리스의 실행본을 만든다 → `.work/e2e/v<X.Y.Z>.md`.
  코어 패스(`.internal/MANUAL-E2E-CHECKLIST.md` §1)와 방금 승격한 CHANGELOG 절을 합쳐서 쓴다. 자동
  스위트가 닿지 않는 것 — 실제 시뮬레이터·에뮬레이터의 스트림, 입력, 녹화 — 만 담는다. 사용자 머신이
  필요하므로 여기서 멈추고 결과를 받고, **그 결과를 릴리스 PR 본문에 붙인다.**
  **7단계 뒤에 돌린다** — 루트 CHANGELOG가 승격되기 전이면 이번 버전 절이 없어 거절한다.
  체크리스트가 없는 클론이면(gitignore) 이 항목은 건너뛴다 — 명령이 그 이유를 말하며 멈춘다.

  이 명령이 존재하는 이유는 체크리스트가 **여덟 릴리스 동안 0회 실행**됐기 때문이다(v0.14.0이 마지막).
  70항목보다 작은 단위가 없었고, 릴리스별 절을 먼저 **다시 써야** 시작할 수 있었다. 생성물은 쓰는 게
  아니라 옮기는 것이라 시작 비용이 없고, 건너뛰면 파일이 없어서 보인다.

## 9. 커밋 → STOP

- `chore: release vX.Y.Z — {테마}` 로 커밋.
- **여기서 멈추고 push/PR 진행 여부를 사용자에게 확인한다.**

## 10. push + PR (확인 후에만)

- `git push -u origin release/vX.Y.Z`
- `gh pr create --base main` — 본문에 버전 표 + 릴리즈노트 + 호환성 근거.
- adversarial review gate가 릴리즈 PR에도 적용된다 — 버전 범프 PR은 docs-only 취급으로 리뷰 생략 가능하되 `.work/reviews/<브랜치>.md`에 스킵 사유 + full HEAD 해시(git rev-parse HEAD) 기록은 필수.
- **PR을 머지하지 않는다.** 머지는 사용자 몫.

## 11. 머지 후 — 태그 push로 발행 트리거 (놓치면 발행이 안 됨)

`.github/workflows/release.yml`은 **`vX.Y.Z` 태그 push로만** 발동한다. **main 머지만으로는 npm 발행이 일어나지 않는다** — 머지 후 태그를 직접 달아야 한다.

- PR 머지를 확인한 뒤, **머지 커밋에** 태그를 단다(이전 릴리즈와 동일한 방식):
  `git fetch origin main && git tag vX.Y.Z <머지 커밋 SHA>`
- **STOP** — 태그 push는 즉시 npm 발행을 유발하는 되돌리기 어려운 작업이다. 사용자 확인 후 진행한다.
- `git push origin vX.Y.Z`
- 워크플로우가 처리하는 것: `pnpm build` → `changeset publish`(공개 패키지 전부, 단일 경로) → GitHub Release 생성. changesets publish는 위상 정렬 없이 동시 발행하므로, 신규 패키지가 있으면 위 7번의 seed publish 전제를 반드시 지킨다.
- 같은 워크플로의 마지막 단계가 최신 stable 태그의 트리(워크플로 파일 제외)를 `docs-production`에 fast-forward로 push한다. 로그에 `move`가 찍혔는지,
  tapflow.dev가 새 버전 문서로 바뀌었는지 확인한다(Vercel production 배포는 1~2분). `skip:`이면 이유가 같이 찍힌다.
  - 배포가 안 바뀌면 Vercel 쪽 두 설정을 본다. Production Branch는 Settings → Environments → Production →
    Branch Tracking에서 `docs-production`이어야 한다(Git 메뉴에는 없다). Ignored Build Step은
    `git rev-parse -q --verify HEAD^ >/dev/null && git diff HEAD^ HEAD --quiet -- ':(top)docs'` — docs 변경이 없는
    릴리스는 건너뛰는 게 정상이다. v0.28.0에서 처음 전환했다.
- npm 인증은 **GitHub OIDC(trusted publishing)** 로 동작한다 — NPM_TOKEN 등 별도 토큰이 필요 없다.
- **발행 확인은 폴링이고, 레지스트리를 직접 읽는다.** v0.20.0에서 예전 확인 셋이 **전부 참이면서 릴리즈는
  설치 불가**였다. 워크플로우 로그는 9개 전부 `published successfully`라고 말했고, 그 시점에 둘은 13분 뒤에야
  나타났다 — 로그는 npm API가 받아들였다는 뜻이지 레지스트리가 서빙한다는 뜻이 아니다. `npm view`는 CDN 캐시를
  읽어, `ios-agent`가 레지스트리 문서에 이미 들어간 뒤에도 `0.19.0`을 돌려줬다. GitHub Releases 페이지는 npm에
  대해 아무 말도 하지 않는다. 게다가 `tapflow` 하나만 봤다 — 9개 중 1개고, 그게 가장 느린 축이었던 건 운이다.

  측정된 반영 시차: 7개 즉시, `ios-agent` 약 1분, `tapflow`·`relay` **약 13분**. 늦은 셋이 가장 큰
  것들이다 — `relay`는 빌드된 대시보드를, `ios-agent`는 notarized 시스템 확장을 품는다.

  ```sh
  set -o pipefail
  # 최신 태그를 버전 순으로 고른다. `git describe`는 HEAD 기준으로 답하므로, 다른 세션이
  # 낡은 브랜치를 체크아웃해 두었으면 직전 릴리즈를 고르고 조용히 그것을 검증한다.
  tag=${1:-$(git tag -l 'v*' --sort=-v:refname | head -1)}
  deadline=$(( $(date +%s) + ${PUBLISH_TIMEOUT:-1200} ))

  # 이름과 기대 버전을 태그에서 읽는다. 작업 트리가 릴리즈 커밋에 있으리란 보장이 없고
  # (다른 세션이 브랜치를 바꿔둘 수 있다), 릴리즈에 버전선이 하나라는 보장도 없다 —
  # v0.20.0에서 audiotap-helper는 0.3.1이었다.
  want=$(git ls-tree -r --name-only "$tag" -- packages 2>/dev/null \
    | grep -E '^packages/[^/]+/package\.json$' \
    | while read -r f; do
        git show "$tag:$f" | python3 -c 'import json,sys
  d = json.load(sys.stdin)
  if not d.get("private"): print(d["name"], d["version"])'
      done)
  n=$(printf '%s' "$want" | grep -c .)
  [ "$n" -ge 2 ] || { echo "found $n published package(s) at $tag — refusing to report on that"; exit 1; }
  echo "verifying $n packages from $tag"

  while :; do
    missing=""; stale=""
    while read -r name ver; do
      [ -n "$name" ] || continue
      # `--max-time`, because a stalled request has no limit of its own and the deadline is only
    # checked between rounds — one hung connection and the poll never reaches it again. A timeout
    # is just this round failing for that package; the next round retries it.
    #
    # Bounded by what is left rather than a flat 30s: nine stalled packages at 30s each is a
    # 270-second round, and the deadline cannot govern a round it is only consulted after. When
    # nothing is left, the package is recorded as unchecked rather than skipped — skipping it
    # silently would let a round end with an empty pending list and announce success for packages
    # no request was ever made about.
    left=$(( deadline - $(date +%s) ))
    if [ "$left" -le 0 ]; then missing="$missing $name@$ver(unchecked, deadline)"; continue; fi
    [ "$left" -gt 30 ] && left=30
    doc=$(curl -sf --max-time "$left" "https://registry.npmjs.org/$(printf '%s' "$name" | sed 's|/|%2f|')") \
        || { missing="$missing $name@$ver(no document)"; continue; }
      got=$(printf '%s' "$doc" | python3 -c 'import json,sys
  d = json.load(sys.stdin); v = sys.argv[1]
  print(("ok" if d.get("dist-tags",{}).get("latest") == v else "latest=" + str(d.get("dist-tags",{}).get("latest"))) if v in d.get("versions",{}) else "absent")' "$ver") \
        || { missing="$missing $name@$ver(unreadable)"; continue; }
      case "$got" in
        ok) ;;
        absent) missing="$missing $name@$ver" ;;
        *)     stale="$stale $name@$ver($got)" ;;
      esac
    done <<EOF
  $want
  EOF
    [ -n "$missing$stale" ] || { echo "all $n packages published, and latest points at them"; break; }
    if [ "$(date +%s)" -ge "$deadline" ]; then
      [ -n "$missing" ] && echo "DEADLINE — never appeared:$missing"
      [ -n "$stale" ] && echo "DEADLINE — published but latest points elsewhere:$stale (checking the wrong tag?)"
      exit 1
    fi
    echo "[$(date +%H:%M:%S)] waiting:$missing$stale"
    # Never sleep past the deadline: with a short PUBLISH_TIMEOUT a fixed sleep is what decides
    # when the check gives up, instead of the deadline doing it.
    nap=$(( deadline - $(date +%s) )); [ "$nap" -gt 30 ] && nap=30
    sleep "$nap"
  done
  ```

  세 가지를 일부러 이렇게 했다:

  - **`versions`에 있는 것과 `dist-tags.latest`가 그것을 가리키는 것은 다르다.** `npm install tapflow`는
    latest를 가져가므로 둘 다 본다. 메시지도 둘을 나눈다 — `absent`는 아직 안 올라온 것이고,
    `latest=…`는 올라왔는데 latest가 딴 데를 가리키는 것이라 **엉뚱한 태그를 검증 중**이라는 뜻일 때가 많다.
  - **기대 버전은 작업 트리가 아니라 태그에서 읽는다.** 다른 세션이 낡은 브랜치를 체크아웃해 둘 수 있다. 이걸
    짜면서 실제로 그 상태였고, 트리에서 읽던 판은 `0.19.0`을 기대하며 영원히 기다렸다. 그리고 릴리즈에
    버전선이 하나라는 보장이 없다 — v0.20.0에서 `audiotap-helper`는 `0.3.1`이었으므로 버전은 패키지마다
    자기 매니페스트에서 읽는다.
  - **태그는 버전 순으로 고르지, `git describe`로 고르지 않는다.** `describe`는 HEAD 기준으로 답한다.
    같은 낡은 브랜치에서 그것이 `v0.19.0`을 골랐고, 검사는 직전 릴리즈를 조용히 검증할 뻔했다.

  일부러 깨뜨려 재봤다: 없는 태그 → 바닥 판정으로 exit 1, 낡은 태그 → `latest points elsewhere`로 exit 1,
  없는 패키지 → `no document`, 발행된 적 없는 버전 → `absent`. 정상 실행은 `all 9 packages published,
  and latest points at them`으로 exit 0.
