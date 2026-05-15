# CONTRIBUTING.md — 브랜치·릴리즈·커밋 컨벤션

> 공통 규칙: [CLAUDE.md](./CLAUDE.md) | 전체 인덱스: [INDEX.md](./INDEX.md)

---

## 브랜치·릴리즈

- `main`은 항상 배포 가능. 직접 커밋 금지. 작업은 `feature/{topic}` 브랜치에서 시작 → PR → merge.
- 새 브랜치는 반드시 `origin/main` 기준으로 생성한다 (`git fetch origin && git checkout -b feature/{topic} origin/main`). 로컬 `main`이 뒤처져 있을 수 있다.
- 배포는 git tag(Semver) → GitHub Release + npm publish. main 머지만으로 자동 배포되지 않는다. `v1.0.0` 이전은 minor에서도 breaking 가능.

## 커밋 메시지 — Conventional Commits

```
<type>(<scope>): <subject>
```

- type: `feat` · `fix` · `test` · `refactor` · `docs` · `chore` · `perf`
- scope: 변경된 패키지명 (`agent-core` · `ios-agent` · `android-agent` · `relay` · `dashboard` · `cli` · `playground`)
