---
title: 팀·역할·토큰
description: 대시보드 Settings의 하위 페이지입니다. 내 프로필, 역할과 초대를 관리하는 멤버 목록(Admin 전용), CI와 원격 에이전트용 개인 액세스 토큰을 다룹니다.
---

# 팀·역할·토큰

대시보드 **Settings**에는 왼쪽 사이드 내비게이션에서 접근할 수 있는 세 개의 하위 페이지가 있습니다.

## Default

현재 로그인한 사용자의 개인 프로필 설정입니다.

- **Workspace** — 팀 이름과 로고를 설정합니다. Admin에게만 보입니다.
- **Apps** — 앱 이름을 바꾸거나 앱을 삭제합니다. Admin, Developer, QA에게 보이고 Viewer에게는 보이지 않습니다.
- **Nickname** — 댓글과 세션 히스토리에 표시됩니다.
- **Avatar** — 아바타의 연필 아이콘을 클릭해 이미지를 업로드합니다 (PNG 또는 JPEG, 최대 2MB).
- **Change password** — 현재 비밀번호가 필요합니다.

## Team

**Admin 전용**으로 표시됩니다.

- **Members list** — 전체 계정 목록 (이메일, 역할, 가입 날짜).
- **Invite member** — 이메일 초대 발송 또는 직접 공유용 링크 생성. 초대는 **7일** 후 만료됩니다.
- **Change role** — 멤버의 역할 재지정 (Admin / Developer / QA / Viewer).
- **Remove member** — 계정을 영구 삭제합니다. 자기 자신은 삭제할 수 없습니다.
- **Reset pwd** — 특정 멤버에게 비밀번호 재설정 이메일을 발송합니다. SMTP가 설정되어 있어야 합니다.

## Tokens

CI/CD 스크립트와 API 접근을 위한 개인 액세스 토큰(PAT)을 관리합니다. 사이드바에는 **Admin**에게만 표시됩니다.

- **New token** — 이름, 만료 기간(**Expiration**), 종류(Type)를 입력합니다. 만료 기간은 7·30·60·90일, 직접 입력(1~365일), **No expiration** 중에서 고르며 기본값은 30일입니다. 만료 기간이 없는 토큰은 폐기할 때까지 유효하므로 CI용이라면 90일 이하를 권장합니다. 목록에서는 이런 토큰에 **No expiration**이 표시되어 정리할 토큰을 찾을 수 있습니다. **API**는 CI 업로드와 API 접근용이고(`view, builds:write` 권한), **Agent**는 원격 Mac 에이전트 연결용입니다. 토큰은 생성 직후 한 번만 표시됩니다. 즉시 복사하세요.
- **Revoke** — 즉시 토큰을 무효화합니다.

CI에서 빌드를 업로드할 때 `Authorization: Bearer tflw_pat_<token>` 헤더로 사용합니다. [빌드 업로드](/ko/testing/app-center)를 참고하세요.
