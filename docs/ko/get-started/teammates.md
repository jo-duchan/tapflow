---
title: 팀원 시작 가이드
description: 팀에서 tapflow 초대 링크를 받은 팀원을 위한 안내입니다. 설치 없이 브라우저로 초대를 수락하고 App Center에서 빌드를 골라 QA 세션에서 기기 화면을 조작합니다. 역할별로 할 수 있는 일과 프로필 설정도 다룹니다.
---

# 팀원 시작 가이드

팀에서 tapflow 초대 링크를 받았다면 이 페이지를 따라 하세요. tapflow는 설치하지 않습니다. iOS 시뮬레이터와 Android 에뮬레이터는 운영자가 준비한 Mac에서 실행되고 여러분은 그 화면을 브라우저로 보면서 조작합니다. 끝나면 App Center에서 빌드를 골라 기기 화면을 직접 탭할 수 있습니다.

::: info 시작하기 전에
- **최신 브라우저**: Chrome, Firefox, Safari, Edge 중 하나면 됩니다.
- **초대 링크**: 팀의 Admin이 대시보드에서 만들어 보내 줍니다. tapflow를 설치해 운영하는 사람(운영자)이 첫 Admin이지만 Admin 역할을 받은 팀원이라면 누구나 초대할 수 있습니다. 링크를 만든 때부터 7일 동안 유효합니다.
- **Tailscale 앱**(운영자가 Tailscale을 쓰는 경우만): 내 컴퓨터에도 Tailscale을 설치하고 운영자와 같은 tailnet에 접속해야 대시보드가 열립니다. [Tailscale](/ko/operate/external-access#tailscale-권장)을 참고하세요.
:::

<a id="_6-팀원에게-공유하기"></a>

## 1. 초대 수락 {#accept-the-invite}

1. 받은 초대 링크를 브라우저로 엽니다. **Set up your account** 화면이 열리고 **You're joining as** 뒤에 초대한 Admin이 정한 역할이 표시됩니다.
2. **Nickname**과 **Avatar**는 선택 항목입니다. 닉네임은 댓글에 이름으로 표시되고 아바타는 PNG나 JPEG 2MB 이하 이미지를 올립니다.
3. **Password**(8자 이상)와 **Confirm password**를 입력하고 **Create account**를 누릅니다. 바로 로그인되고 App Center가 열립니다.

초대 링크를 열어도 페이지가 뜨지 않으면 아래 [주소 표](#bookmark-the-address)에서 내 경우를 확인하거나 운영자에게 문의하세요.

링크를 열었을 때 **Invitation expired**가 나오면 링크가 만료되었거나 이미 사용된 링크입니다. Admin에게 새 링크를 요청하세요. 자세한 내용은 [로그인과 계정 문제 해결](/ko/troubleshooting/accounts)을 참고하세요.

## 2. 대시보드 주소 저장 {#bookmark-the-address}

대시보드 주소는 초대 링크에서 `/invite` 앞부분입니다. 예를 들어 링크가 `http://192.168.0.10:4000/invite?token=…`이면 주소는 `http://192.168.0.10:4000`입니다. 북마크해 두고 다음부터는 이 주소를 열어 **Email**과 **Password**를 입력한 뒤 **Sign in**을 누릅니다. 한 번 로그인하면 7일 동안 유지됩니다.

주소의 형태는 운영자의 구성에 따라 다릅니다.

| 운영자의 구성 | 여는 주소 |
|---|---|
| 같은 사무실 네트워크 | 운영자 Mac의 LAN 주소. 예: `http://192.168.0.10:4000` |
| Tailscale | tailnet 주소. 내 컴퓨터에서도 Tailscale이 켜져 있어야 합니다 |
| VPS 터널 | 공개 주소. 예: `https://your-vps.com` |

`localhost`가 들어간 주소는 운영자의 Mac에서만 열립니다. 그런 주소를 받았다면 운영자에게 다시 요청하세요.

## 3. 빌드 테스트 {#test-a-build}

1. App Center 왼쪽 **Apps** 목록에서 테스트할 앱을 고릅니다. 처음 열면 목록의 첫 번째 앱이 선택되어 있으니 앱이 여러 개라면 먼저 확인하세요.
2. 테스트할 빌드를 찾습니다. **Search version or label…** 검색창과 상태 필터로 목록을 좁힐 수 있습니다.
3. 빌드 행의 **Start QA**를 누릅니다. 리뷰 상태가 **Done**인 빌드는 이 버튼이 꺼져 있습니다.
4. **Select Mac** 화면에서 Mac을 고르고 **Select device** 화면에서 기기를 클릭합니다. 다른 팀원이 쓰고 있는 기기는 **In use**로 표시되어 고를 수 없습니다.
5. 기기가 켜지고 빌드 설치가 끝나면 툴바의 **Launch app**을 눌러 앱을 실행합니다.

기기 화면을 클릭하면 탭이 되고 드래그하면 스와이프가 됩니다. 키보드로 입력하려면 기기 화면을 한 번 클릭한 뒤 입력합니다. 다른 조작은 [기기 조작](/ko/testing/device-controls)을 참고하세요.

## 4. 결과 공유 {#leave-feedback}

테스트하며 발견한 내용은 빌드에 [댓글](/ko/testing/comments)로 남깁니다. 같은 빌드를 여는 팀원 모두가 봅니다. 댓글에는 이미지를 붙일 수 있고 화면을 [스크린샷이나 녹화](/ko/testing/screenshots-and-recordings)로 남길 수도 있습니다.

## 역할별로 할 수 있는 일 {#roles}

계정마다 초대한 Admin이 정한 역할이 있습니다. 역할은 Admin이 바꿉니다.

| 역할 | 할 수 있는 일 |
|---|---|
| Viewer | 빌드를 보고 QA 세션에서 테스트하고 댓글과 녹화를 남깁니다. 댓글과 녹화 외에는 읽기 전용이라 빌드 업로드, 리뷰 상태 변경, 앱 관리는 할 수 없습니다. |
| QA, Developer | Viewer가 하는 일에 더해 빌드 업로드, 리뷰 상태 변경, 빌드 삭제 예약, 앱 추가·수정·삭제, 웹훅 관리를 합니다. 두 역할의 권한은 같습니다. |
| Admin | 모든 작업을 합니다. 팀원 초대·역할 변경·삭제, 비밀번호 재설정, 워크스페이스 설정, 토큰 관리는 Admin만 할 수 있습니다. |

Viewer가 **Upload build**나 **Add App**을 누르면 QA나 Developer 권한이 필요하다는 알림이 뜹니다. 역할과 멤버 관리는 [팀·역할·토큰](/ko/operate/team-and-roles)에서 자세히 다룹니다.

<a id="default"></a>

## 프로필 설정 {#profile}

사이드바 아래쪽의 내 이름을 누르고 **Settings**를 고르면 설정 화면이 열립니다.

- **Profile**: **Nickname**과 **Avatar**를 바꾸고 **Save changes**를 누릅니다.
- **Password**: **Current password**, **New password**, **Confirm new password**를 입력해 비밀번호를 바꿉니다.

비밀번호를 잊었다면 Admin에게 요청하세요. Admin이 **Settings → Team**에서 **Reset pwd**를 누르면 재설정 링크가 표시되고 Admin이 그 링크를 전달해 줍니다. tapflow가 메일을 보낼 수 있으면(SMTP 설정) 링크가 메일로도 갑니다. 링크는 2시간 동안 한 번만 쓸 수 있습니다. 재설정하면 모든 브라우저에서 로그아웃되니 새 비밀번호로 다시 로그인하세요. 로그아웃은 같은 메뉴의 **Log out**으로 합니다.

## 다음 단계 {#next-steps}

- [앱 테스트](/ko/testing): App Center와 QA 세션에서 쓸 수 있는 기능 전체를 안내합니다.
- [QA 세션](/ko/testing/qa-session): Mac과 기기를 고르는 화면, 정보 카드, 세션이 끝나는 경우를 설명합니다.
- [App Center](/ko/testing/app-center): 빌드 목록, 리뷰 상태, 검색과 필터를 다룹니다.
- [로그인과 계정 문제 해결](/ko/troubleshooting/accounts): 초대 링크나 비밀번호 재설정 링크가 만료되었을 때 볼 페이지입니다.
