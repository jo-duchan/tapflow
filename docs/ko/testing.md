---
title: 앱 테스트
description: 팀원이 대시보드에서 빌드를 테스트하는 곳입니다. App Center에 업로드된 빌드가 모이고 QA 세션에서 기기 화면이 브라우저로 스트리밍됩니다.
---

<a id="대시보드-개요"></a>

# 앱 테스트

팀원은 업로드된 빌드가 모이는 App Center와 기기 화면을 브라우저로 스트리밍하는 QA 세션, 두 화면에서 빌드를 테스트합니다.

## App Center

**경로**: `/app-center`

팀의 주요 작업 공간입니다. 업로드된 모든 빌드를 앱별로 정리해 보여줍니다.

| UI 요소 | 기능 |
|---------|------|
| 앱 목록 | bundle ID + 플랫폼으로 빌드를 그룹화합니다. 앱을 고르면 버전별로 묶인 빌드 목록이 보입니다. **Add App**으로 앱을 직접 추가할 수 있습니다. |
| 빌드 행 | 빌드 번호, 플랫폼, 상태 배지, 업로더, 업로드 날짜를 표시합니다. 클릭하면 해당 빌드의 QA 세션 화면이 열립니다. |
| 상태 | **Backlog** · **In Progress** · **Done** · **Rejected** — 빌드 행의 상태 선택 메뉴에서 변경합니다. Viewer에게는 상태 선택 메뉴와 삭제 예약 버튼이 보이지 않고 상태 배지만 보입니다. |
| Upload build | 빌드 업로드 다이얼로그를 엽니다. `.app.zip` 또는 `.tar.gz`/`.tgz` (iOS 시뮬레이터 빌드), `.apk` (Android)를 허용합니다. |

Viewer는 읽기 전용입니다. Viewer가 **Add App**이나 **Upload build**를 누르면 다이얼로그 대신 QA나 Developer 권한이 필요하다는 안내가 표시됩니다. 역할별 권한은 [팀원 초대](/ko/dashboard/setup#_3-팀원-초대)를 참고하세요.

## 옮겨진 섹션 {#moved-sections}

이 페이지에 있던 섹션은 아래 페이지로 옮겨졌습니다.

- [QA 세션](/ko/testing/qa-session)
  - <a id="qa-세션" data-moved-to="/ko/testing/qa-session#qa-세션"></a>[QA 세션](/ko/testing/qa-session#qa-세션)
- [Mac 리소스 확장](/ko/operate/scaling)
  - <a id="mac-resources" data-moved-to="/ko/operate/scaling#mac-resources"></a>[Mac Resources](/ko/operate/scaling#mac-resources)
- [팀·역할·토큰](/ko/operate/team-and-roles)
  - <a id="settings" data-moved-to="/ko/operate/team-and-roles"></a>[Settings](/ko/operate/team-and-roles)
  - <a id="default" data-moved-to="/ko/operate/team-and-roles#default"></a>[Default](/ko/operate/team-and-roles#default)
  - <a id="team" data-moved-to="/ko/operate/team-and-roles#team"></a>[Team](/ko/operate/team-and-roles#team)
  - <a id="tokens" data-moved-to="/ko/operate/team-and-roles#tokens"></a>[Tokens](/ko/operate/team-and-roles#tokens)
