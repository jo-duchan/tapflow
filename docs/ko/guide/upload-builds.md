# 빌드 업로드

팀이 직접 확인할 수 있도록 iOS 또는 Android 빌드를 업로드합니다.

## 대시보드에서 업로드

App Center에서 **Upload Build**를 클릭하고 파일을 선택합니다.

- iOS: `.app.zip` — 시뮬레이터용 바이너리 ([커맨드라인 빌드 방법](https://developer.apple.com/library/archive/technotes/tn2339/_index.html))
- Android: `.apk`

::: warning iOS — `.ipa` 파일은 지원하지 않습니다
`.ipa`는 실제 기기용 포맷입니다. tapflow는 시뮬레이터용 `.app.zip`만 허용합니다. 업로드 오류가 발생하면 [문제 해결](/ko/guide/troubleshooting#ios-빌드-업로드-오류)을 참고하세요.
:::

업로드 시 bundle ID를 기준으로 App에 연결되고, 최초 업로드 시 App을 자동으로 생성합니다. 또한 App을 먼저 생성한 뒤 빌드를 연결하는 것도 가능합니다.

## API 업로드 (CI/CD)

먼저 **Settings → Tokens**에서 Personal Access Token을 생성합니다.

```sh
# iOS
curl -X POST https://your-relay/api/v1/builds \
  -H "Authorization: Bearer tflw_pat_xxx" \
  -F "file=@MyApp.app.zip" \
  -F "status=In Progress"

# Android
curl -X POST https://your-relay/api/v1/builds \
  -H "Authorization: Bearer tflw_pat_xxx" \
  -F "file=@MyApp.apk"
```

### 선택 필드

| 필드 | 설명 |
|------|------|
| `status` | `Backlog` \| `In Progress` \| `Done` \| `Rejected` |
| `label` | 빌드에 표시할 커스텀 레이블 (예: `"rc-1"`, `"hotfix"`) |
| `app_id` | 기존 App에 명시적으로 연결할 때 사용. 없으면 bundle ID로 자동 매칭 |

## GitHub Actions 예시

```yaml
- name: Upload to tapflow
  env:
    TAPFLOW_RELAY_URL: ${{ secrets.TAPFLOW_RELAY_URL }}
    TAPFLOW_PAT: ${{ secrets.TAPFLOW_PAT }}
  run: |
    curl -X POST "$TAPFLOW_RELAY_URL/api/v1/builds" \
      -H "Authorization: Bearer $TAPFLOW_PAT" \
      -F "file=@MyApp.app.zip" \
      -F "status=In Progress"
```

## 빌드 상태

| 상태 | 의미 |
|------|------|
| Backlog | 리뷰 준비 전 |
| In Progress | 리뷰 준비 완료 |
| Done | 이해관계자 승인 완료 |
| Rejected | 문제 발견, 수정 필요 |
