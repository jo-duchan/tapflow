---
title: 로그인과 계정
description: "`tapflow admin init`이 Already initialized로 실패할 때, 초대 링크나 비밀번호 재설정 링크가 만료됐을 때의 해결 방법입니다."
---

# 로그인과 계정

## `tapflow admin init` 실패 (`Already initialized`)

릴레이에 이미 관리자 계정이 존재합니다. 대시보드에 로그인한 뒤 **Settings → Team**에서 팀원을 초대하세요.

## 초대 링크가 만료됨

초대 링크는 **7일** 후 만료됩니다. Admin이 **Settings → Team**에서 새 초대를 만들어야 합니다. SMTP가 설정되지 않은 경우 초대 다이얼로그에 표시된 링크를 복사해 공유할 수 있습니다.

## 비밀번호 재설정 링크가 만료됨

비밀번호 재설정 링크는 **2시간** 후 만료됩니다. Admin이 **Settings → Team**에서 해당 멤버 행의 **Reset pwd**를 눌러 새 링크를 보낼 수 있습니다. 재설정 링크는 이메일로만 전달되므로 SMTP가 설정되어 있어야 합니다.
