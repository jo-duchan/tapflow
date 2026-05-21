# tapflow

## 0.2.0

### Minor Changes

- Add typed errors, CLI install banner, and dashboard toast feedback

  - **typed errors** (`agent-core`): `ValidationError`, `PlatformError`, `AuthError` exported from `@tapflowio/agent-core`; key runtime throw sites updated for typed `instanceof` handling (#63)
  - **CLI install banner**: `postinstall` prints success banner after global npm install (suppressed in CI / non-TTY / local workspace); `tapflow` with no args shows version banner and quick-start commands (#90)
  - **dashboard toast feedback**: sonner toasts on all key mutation flows — token create/revoke/copy, workspace/profile/password/app settings, app creation, build upload; `confirm()` replaced with `AlertDialog`; `toast.promise` for upload progress (#91)

### Patch Changes

- Updated dependencies
  - @tapflowio/agent-core@0.2.0
  - @tapflowio/ios-agent@0.2.0
  - @tapflowio/android-agent@0.2.0
  - @tapflowio/relay@0.2.0

## 0.1.0

### Patch Changes

- a27f220: fix(ci): use --tag alpha for changeset publish in pre mode
- f13bd85: **Breaking change**: default `dataDir` renamed from `.tapflow` to `.tapflow-data`.

  If you have an existing `.tapflow/` directory, either rename it to `.tapflow-data/` or set `dataDir: ".tapflow"` in `tapflow.config.json` to keep using the old path.

- Updated dependencies [f13bd85]
  - @tapflowio/relay@0.1.0
  - @tapflowio/android-agent@0.1.0
  - @tapflowio/ios-agent@0.1.0
  - @tapflowio/agent-core@0.1.0

## 0.1.0-alpha.8

### Patch Changes

- fix(ci): use --tag alpha for changeset publish in pre mode
  - @tapflowio/agent-core@0.1.0-alpha.8
  - @tapflowio/ios-agent@0.1.0-alpha.8
  - @tapflowio/android-agent@0.1.0-alpha.8
  - @tapflowio/relay@0.1.0-alpha.8

## 0.1.0-alpha.7

### Patch Changes

- f13bd85: **Breaking change**: default `dataDir` renamed from `.tapflow` to `.tapflow-data`.

  If you have an existing `.tapflow/` directory, either rename it to `.tapflow-data/` or set `dataDir: ".tapflow"` in `tapflow.config.json` to keep using the old path.

- Updated dependencies [f13bd85]
  - @tapflowio/relay@0.1.0-alpha.7
  - @tapflowio/android-agent@0.1.0-alpha.7
  - @tapflowio/ios-agent@0.1.0-alpha.7
  - @tapflowio/agent-core@0.1.0-alpha.7

## 0.1.0-alpha.2

### Patch Changes

- fix(release): correct build filter name for CLI package and add npm README thumbnail
  - @tapflowio/agent-core@0.1.0-alpha.2
  - @tapflowio/ios-agent@0.1.0-alpha.2
  - @tapflowio/android-agent@0.1.0-alpha.2
  - @tapflowio/relay@0.1.0-alpha.2
