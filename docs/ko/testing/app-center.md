---
title: App Center
description: 업로드된 빌드를 앱과 버전별로 모아 보는 화면입니다. 빌드 업로드, 검색과 상태 필터, 리뷰 상태, 삭제 예약, QA 세션 시작을 다룹니다.
---

<a id="빌드-업로드"></a>

# App Center

App Center는 tapflow 대시보드 안의 빌드 목록 화면입니다. Microsoft App Center와는 관계가 없습니다. 팀이 올린 iOS·Android 빌드가 앱별, 버전별로 모이고 여기서 빌드를 골라 QA 세션을 시작합니다. 대시보드에 로그인하면 가장 먼저 열리는 화면입니다.

## 사용 방법 {#how-to-use}

1. 왼쪽 **Apps** 목록에서 앱을 고릅니다. 앱은 bundle ID(iOS 번들 ID 또는 Android 패키지 이름)로 구분됩니다. 한 앱이 플랫폼마다 다른 bundle ID를 가질 수 있습니다.
2. 빌드는 버전 이름별로 접고 펼 수 있는 묶음(릴리스)에 모입니다. 버전 이름을 읽을 수 없는 빌드는 **Unversioned** 묶음에 들어갑니다.
3. 테스트할 빌드 행에서 **Start QA**를 누릅니다. 그 빌드의 [QA 세션](/ko/testing/qa-session)이 열립니다.

빌드 행에는 빌드 번호, 레이블, 플랫폼, 리뷰 상태 배지, 삭제 예약 배지, 업로더, 업로드 날짜가 표시됩니다. 버전이나 빌드 번호를 [바꾼](#edit-a-build) 빌드에는 **Edited** 배지가 붙습니다.

### 빌드 찾기 {#find-a-build}

- **Search version or label…** 검색창에 버전 이름이나 레이블의 일부를 입력하면 그 문자열이 들어간 빌드만 보입니다.
- 상태 필터(기본값 **All statuses**)에서 **Backlog**, **In Progress**, **Done**, **Rejected** 중 하나를 고르면 그 상태의 빌드만 보입니다.

조건에 맞는 빌드가 없으면 **No matching builds**가 표시됩니다.

## 빌드 업로드 {#upload-a-build}

<a id="대시보드에서-업로드"></a>

1. 화면 오른쪽 위의 **Upload build**를 누릅니다.
2. **File** 영역을 클릭해 파일을 고르거나 파일을 끌어다 놓습니다.
   - iOS: 시뮬레이터용 빌드인 `.app.zip` 또는 `.tar.gz`/`.tgz`. `.app.zip`은 [커맨드라인으로 빌드](https://developer.apple.com/library/archive/technotes/tn2339/_index.html)해 `.app` 폴더를 압축한 파일입니다. EAS 같은 클라우드 시뮬레이터 빌드의 `.tar.gz`/`.tgz`는 그대로 올립니다.
   - Android: `.apk`
3. 필요하면 **Status (optional)**에서 리뷰 상태를 미리 고릅니다. 기본값 **None**이면 상태 없이 올라갑니다.
4. 필요하면 **Label (optional)**에 브랜치 이름이나 `staging, feature X` 같은 메모를 적습니다. 빌드 행에 표시되고 검색으로 찾을 수 있습니다.
5. 빌드 파일의 버전이나 빌드 번호 대신 다른 값을 쓰려면 **Override version**을 펼쳐 **Version**이나 **Build number**를 적습니다. 비워 둔 칸은 빌드 파일의 값을 씁니다.
6. **Upload**를 누릅니다. 올라가면 **Build uploaded** 알림이 뜨고 목록에 빌드가 추가됩니다.

::: warning iOS `.ipa` 파일은 지원하지 않습니다
`.ipa`는 실제 기기용 포맷입니다. tapflow는 시뮬레이터용 `.app.zip`과 `.tar.gz`/`.tgz`를 받습니다. 업로드 오류가 나면 [빌드와 업로드 문제 해결](/ko/troubleshooting/builds#ios-빌드-업로드-오류)을 참고하세요.
:::

업로드한 빌드는 bundle ID를 기준으로 앱에 연결됩니다. 같은 bundle ID의 앱이 없으면 새 앱이 만들어집니다. 앱을 고른 상태에서 올리면 그 앱에 연결됩니다. 그 앱에 해당 플랫폼의 bundle ID가 아직 없으면 빌드의 bundle ID가 앱에 추가됩니다. 그래서 iOS와 Android의 bundle ID가 다른 앱도 하나로 모을 수 있습니다. 빌드의 bundle ID를 다른 앱이 이미 쓰고 있거나 고른 앱에 그 플랫폼의 bundle ID가 따로 있으면, 빌드는 자기 bundle ID의 앱으로 갑니다.

**Apps** 목록 아래의 **Add App**으로 앱을 먼저 만들어 둘 수도 있습니다. **Name**, **Bundle ID**, **Platform**(iOS, Android, Both)을 입력합니다.

CI 파이프라인에서 빌드를 자동으로 올리는 방법은 [CI에서 빌드 올리기](/ko/operate/ci-distribution)를 참고하세요.

## 빌드 정보 바꾸기 {#edit-a-build}

빌드 행의 **⋯** 메뉴에서 **Edit build**를 고르면 레이블, 버전, 빌드 번호를 바꿀 수 있습니다. **Admin, Developer, QA** 역할이 필요합니다.

- **Label**: 빌드에 붙이는 메모입니다. 비우면 레이블이 없어집니다.
- **Version**, **Build number**: 빌드 파일에서 읽은 값 대신 쓸 값입니다. 칸 아래에 빌드 파일의 값이 표시되고 칸을 비우면 그 값으로 돌아갑니다.

버전을 바꾸면 빌드가 그 버전의 릴리스로 옮겨 가고 그 릴리스가 펼쳐집니다. 버전 이름을 읽지 못해 **Unversioned**에 들어간 빌드도 이렇게 버전을 정해 줄 수 있습니다.

바꾼 값은 tapflow가 빌드를 보여 주고 묶는 데만 쓰입니다. 기기에 설치되는 앱은 올린 파일 그대로이며 그 앱의 버전도 바뀌지 않습니다. 값을 바꾼 빌드에는 **Edited** 배지가 붙습니다. 배지에 마우스를 올리거나 키보드로 가면 빌드 파일의 값이 보입니다.

## 앱 합치기와 나누기 {#merge-apps}

iOS와 Android의 bundle ID가 달라 한 제품이 두 앱으로 나뉘어 있으면 하나로 합칠 수 있습니다. 잘못 합친 앱이나 엉뚱한 앱에 붙은 bundle ID는 다시 나눌 수 있습니다. **Admin, Developer, QA** 권한이 필요합니다.

### 합치기

1. **Settings**의 **Apps** 카드에서 **Arrange apps**를 누릅니다. 각 bundle ID 줄 앞에 손잡이가 나타나고 줄이 흔들리기 시작합니다.
2. 옮길 bundle ID 줄을 남길 앱 위로 끌어다 놓습니다. 키보드로는 손잡이에서 Space를 눌러 집습니다. 방향키로 앱을 고른 뒤 Space를 눌러 놓습니다.
3. 확인 창에서 **Merge**를 누릅니다.

그 플랫폼의 bundle ID와 빌드가 남길 앱으로 옮겨집니다. 빌드에 딸린 댓글, 녹화, 실행 기록도 함께 옮겨집니다. 원래 앱에 남은 것이 없으면 원래 앱은 삭제됩니다. 앱 이름은 남길 앱의 이름을 그대로 씁니다. 합친 앱은 아래처럼 다시 나눌 수 있습니다. 다만 삭제된 앱의 이름은 돌아오지 않습니다.

삭제된 앱의 `app_id`로 빌드를 올리는 CI도 계속 동작합니다. 빌드의 bundle ID로 앱을 찾아 연결하기 때문입니다.

### 나누기

1. **Arrange apps**를 누르고 떼어 낼 bundle ID 줄을 집습니다. 그 줄이 있던 앱 바로 아래에 **New app** 영역이 나타납니다.
2. 줄을 **New app**에 놓습니다. 키보드로는 줄을 집은 뒤 아래 방향키로 **New app**까지 옮기고 Space를 누릅니다.
3. 확인 창에서 새 앱 이름을 정하고 **Split**을 누릅니다. 기본 이름은 원래 앱 이름 뒤에 플랫폼을 붙인 것입니다.

그 플랫폼의 bundle ID와 빌드가 새 앱으로 옮겨집니다. 새 앱은 목록 맨 위에 나옵니다. 원래 앱에는 다른 플랫폼이 남아야 하므로 줄이 하나뿐인 앱에서는 **New app**이 나타나지 않습니다.

원래 앱의 `app_id`로 올린 빌드도 옮긴 bundle ID를 가졌으면 새 앱으로 갑니다. bundle ID 없이 빌드만 있던 줄을 떼어 냈다면 CI의 `app_id`를 새 앱으로 바꾸세요. bundle ID를 읽지 못한 빌드는 `app_id`를 따라가기 때문입니다.

### 옮길 수 없는 줄

이런 줄에는 손잡이가 없고 흔들리지 않습니다. 줄에 마우스를 올리거나 포커스하면 이유가 보입니다.

- 두 플랫폼에 같은 bundle ID를 쓰는 앱의 줄입니다. 이런 앱은 이미 한 앱으로 모여 있습니다.
- bundle ID를 읽지 못한 빌드를 모아 두는 앱의 줄입니다.

끄는 동안 그 줄을 놓을 수 없는 앱은 흐리게 보입니다. 같은 플랫폼의 bundle ID가 이미 있는 앱이 그렇습니다. bundle ID 없이 빌드만 있는 줄은 그런 앱에도 놓을 수 있습니다.

## 리뷰 상태 {#review-status}

리뷰 상태는 빌드를 어디까지 확인했는지 팀에 알리는 표시입니다. 빌드 행의 상태 메뉴에서 바꿉니다.

| 상태 | 의미 |
|---|---|
| — | 상태 없음 |
| **Backlog** | 준비 전 |
| **In Progress** | 리뷰 준비 완료 |
| **Done** | 이해관계자 승인 완료 |
| **Rejected** | 문제 발견, 수정 필요 |

- **Done**인 빌드는 **Start QA** 버튼이 비활성화됩니다. 승인이 끝난 빌드를 다시 테스트하려면 상태를 먼저 바꿉니다.
- QA 세션을 열면 Mac을 고르기 전 화면 위쪽 경로 표시(breadcrumb) 옆에 상태 배지가 보입니다.
- 상태가 **Done**이나 **Rejected**로 바뀌면 운영자가 등록한 [리뷰 웹훅](/ko/operate/webhooks)이 호출됩니다.

## 빌드 삭제 예약 {#schedule-deletion}

더 이상 필요 없는 빌드는 행의 **⋯** 메뉴에서 **Schedule deletion**을 골라 삭제를 예약합니다. 확인 창에서 **Schedule deletion**을 누르면 7일 뒤 빌드 파일이 삭제되고 행에 **Deletes in 6d** 같은 남은 시간 배지가 붙습니다.

그 전에는 같은 메뉴의 **Cancel scheduled deletion**으로 언제든 취소할 수 있습니다. 삭제 예약은 리뷰 상태와 따로 움직입니다.

## 플랫폼 지원 {#platform-support}

| | iOS | Android |
|---|---|---|
| 업로드 파일 | `.app.zip`, `.tar.gz`/`.tgz` (시뮬레이터 빌드) | `.apk` |
| 앱을 구분하는 값 | 번들 ID | 패키지 이름 |

## 제한 사항 {#limits}

- Viewer 역할은 읽기 전용입니다. Viewer가 **Upload build**나 **Add App**을 누르면 창 대신 QA나 Developer 권한이 필요하다는 알림이 뜹니다. Viewer에게는 상태 메뉴와 **⋯** 메뉴가 보이지 않고 **Start QA**와 상태 배지만 보입니다. 역할별 권한은 [팀·역할·토큰](/ko/operate/team-and-roles#team)을 참고하세요.
- 목록에는 앱마다 최근에 올린 빌드 100개까지 보입니다. 더 오래된 빌드는 버전 검색으로 찾습니다.
- App Center에서는 앱 이름을 바꾸거나 앱을 지울 수 없습니다. Admin, Developer, QA 역할은 **Settings → Default**의 **Apps** 카드에서 각 앱의 **⋯** 메뉴(**Edit**, **Delete**)로 할 수 있습니다. 앱을 지우면 그 앱의 빌드도 모두 지워집니다.
- 삭제 예약 확인 창은 항상 7일이라고 안내합니다. 운영자가 릴레이의 `TAPFLOW_BUILD_TTL_DAYS`를 바꿨다면 실제 기간은 그 값을 따릅니다.

## 문제 해결 {#troubleshooting}

- 업로드가 `400` 오류로 실패하면 [iOS 빌드 업로드 오류](/ko/troubleshooting/builds#ios-빌드-업로드-오류)를 참고하세요.
- APK가 **Unversioned**로 표시되거나 다른 앱에 합쳐지면 [빌드와 업로드](/ko/troubleshooting/builds) 페이지를 참고하세요. 버전만 정해 주면 되는 경우에는 [빌드 정보 바꾸기](#edit-a-build)로 바로 바꿀 수 있습니다.

## 관련 문서 {#related}

- [QA 세션](/ko/testing/qa-session): **Start QA**를 누른 뒤 Mac과 기기를 고르는 방법
- [CI에서 빌드 올리기](/ko/operate/ci-distribution): 파이프라인에서 빌드를 자동으로 올리는 방법
- [리뷰 웹훅](/ko/operate/webhooks): 리뷰 상태가 바뀔 때 외부 시스템에 알리는 방법
