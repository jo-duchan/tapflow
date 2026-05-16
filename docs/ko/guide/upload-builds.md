# 빌드 업로드

QA가 시뮬레이터에 설치할 수 있도록 iOS 또는 Android 빌드를 업로드합니다.

## 대시보드에서 업로드

App Center에서 **Upload Build**를 클릭하고 파일을 선택합니다.

- iOS: `.app.zip` — `xcodebuild -sdk iphonesimulator`로 빌드한 `.app` 번들을 zip으로 압축한 파일
- Android: `.apk`

::: warning iOS 빌드 준비 시 주의사항
**`.ipa` 파일은 지원하지 않습니다.** `.ipa`는 실제 기기용 포맷입니다. tapflow는 시뮬레이터용 `.app.zip`만 허용합니다.

`.app` 폴더는 ZIP의 루트에 있어야 합니다. 상위 폴더로 감싸면 메타데이터 파싱에 실패합니다.

```
MyApp.app.zip
└── MyApp.app/        ← 루트에 바로 위치해야 함
    ├── Info.plist
    └── ...
```
:::

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
  run: |
    curl -X POST ${{ secrets.TAPFLOW_RELAY_URL }}/api/v1/builds \
      -H "Authorization: Bearer ${{ secrets.TAPFLOW_PAT }}" \
      -F "file=@MyApp.app.zip" \
      -F "status=In Progress"
```

## 업로드 후 처리 흐름

1. 릴레이가 바이너리에서 메타데이터를 추출합니다:
   - iOS: `Info.plist` → `CFBundleIdentifier`, `CFBundleShortVersionString`, `CFBundleVersion`
   - Android: `AndroidManifest.xml` 파싱 (aapt 사용)
2. bundle ID로 **App** 항목을 조회합니다:
   - 첫 업로드 → App이 자동 생성됩니다
   - 동일 bundle ID, 동일 플랫폼 → 기존 App에 빌드가 추가됩니다
   - 동일 bundle ID, 다른 플랫폼 → App의 플랫폼이 `both`로 업그레이드됩니다 (iOS·Android를 하나의 App으로 통합)
3. App 하위에 **Build** 항목이 생성됩니다.
4. QA가 App Center에서 즉시 새 빌드를 확인할 수 있습니다.

## 빌드 상태

| 상태 | 의미 |
|------|------|
| Backlog | 테스트 준비 전 |
| In Progress | 개발 진행 중 |
| Done | QA 통과 |
| Rejected | 수정 필요 |
