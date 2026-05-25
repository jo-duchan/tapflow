# @tapflowio/agent-core

## 0.2.2

## 0.2.1

### Patch Changes

- fix: WebSocket backpressure, Android pinch via scrcpy multi-touch, dashboard skeleton visibility

## 0.2.0

### Minor Changes

- Add typed errors, CLI install banner, and dashboard toast feedback

  - **typed errors** (`agent-core`): `ValidationError`, `PlatformError`, `AuthError` exported from `@tapflowio/agent-core`; key runtime throw sites updated for typed `instanceof` handling (#63)
  - **CLI install banner**: `postinstall` prints success banner after global npm install (suppressed in CI / non-TTY / local workspace); `tapflow` with no args shows version banner and quick-start commands (#90)
  - **dashboard toast feedback**: sonner toasts on all key mutation flows — token create/revoke/copy, workspace/profile/password/app settings, app creation, build upload; `confirm()` replaced with `AlertDialog`; `toast.promise` for upload progress (#91)

## 0.1.0

## 0.1.0-alpha.8

## 0.1.0-alpha.7

## 0.1.0-alpha.2
