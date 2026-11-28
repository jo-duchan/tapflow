---
title: 댓글
description: QA 세션에서 빌드에 글과 이미지를 남겨 팀과 공유합니다. 댓글은 날짜별 목록으로 쌓이고 댓글마다 링크를 복사해 전달할 수 있습니다.
---

# 댓글

댓글은 빌드마다 남기는 메모입니다. 테스트하며 발견한 문제를 글과 스크린샷으로 남기면 같은 빌드를 여는 팀원 모두가 봅니다. 모든 역할이 댓글을 쓸 수 있고 따로 켤 설정은 없습니다.

## 사용 방법 {#how-to-use}

1. [QA 세션](/ko/testing/qa-session)에서 정보 카드 아래 **Comments** 탭을 엽니다. 세션을 열면 이 탭이 먼저 보입니다.
2. **Leave a comment…** 입력란에 내용을 씁니다.
3. 이미지를 붙이려면 **Attach image** 버튼을 누르고 파일을 고릅니다.
4. **Post comment** 버튼을 누릅니다.

댓글은 스레드 없이 하나의 목록으로 쌓이고 **Today**, **Yesterday**, 날짜 순으로 묶여 보입니다. 댓글마다 작성자와 시각이 표시되고 첨부 이미지를 누르면 새 탭에서 열립니다.

### 댓글 링크 공유 {#comment-links}

댓글 옆 링크 버튼(**Copy link to comment**)을 누르면 그 댓글로 바로 가는 주소가 복사되고 **Link copied** 알림이 뜹니다. 주소는 `#comment-<번호>`로 끝납니다. 받은 사람이 주소를 열면 그 댓글로 스크롤되고 잠시 강조 표시됩니다.

## 플랫폼 지원 {#platform-support}

댓글은 기기가 아니라 빌드에 붙으므로 iOS와 Android 빌드에서 똑같이 동작합니다.

## 제한 사항 {#limits}

- 첨부 이미지는 PNG, JPG, WebP만 받고 5MB까지입니다. 다른 형식이면 **Only png, jpg, webp allowed**, 크기를 넘으면 **Max 5MB**가 표시됩니다.
- 대시보드에서는 댓글을 고치거나 지울 수 없습니다. 지우는 것은 [REST API](/ko/reference/api#delete-api-v1-comments-id)로 작성자 본인이나 Admin만 할 수 있습니다.
- 댓글 링크 복사는 대시보드를 HTTPS(또는 `localhost`)로 열었을 때만 됩니다. HTTP에서는 브라우저가 클립보드 쓰기를 막아 **Could not copy link**가 표시됩니다.

## 설정(운영자) {#setup-operator}

CI에서 빌드를 올리면서 브랜치나 커밋 정보를 댓글로 남길 수 있습니다. 방법은 [CI에서 빌드 올리기](/ko/operate/ci-distribution)를 참고하세요. 첨부 크기 상한은 릴레이의 `TAPFLOW_MAX_COMMENT_BYTES`로 바꿀 수 있지만 대시보드는 5MB를 넘는 파일을 올리기 전에 막습니다.

## 문제 해결 {#troubleshooting}

- **Couldn't load comments.**가 표시되면 목록을 불러오지 못한 상태이므로 페이지를 새로고침합니다.
- **Could not copy link** 알림이 뜹니다. 대시보드 주소가 `http://`로 시작하는지 확인합니다. HTTPS 설정은 운영자에게 요청합니다.

## 관련 문서 {#related}

- [스크린샷과 녹화](/ko/testing/screenshots-and-recordings): 댓글에 붙일 화면을 남기는 방법
- [App Center](/ko/testing/app-center#review-status): 확인이 끝난 빌드의 리뷰 상태를 바꾸는 방법
- [CI에서 빌드 올리기](/ko/operate/ci-distribution): CI에서 댓글을 남기는 방법
