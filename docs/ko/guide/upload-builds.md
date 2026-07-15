# 빌드 업로드

팀이 직접 확인할 수 있도록 iOS 또는 Android 빌드를 업로드합니다.

## 대시보드에서 업로드

App Center에서 **Upload Build**를 클릭하고 파일을 선택합니다.

- iOS: `.app.zip` 또는 `.tar.gz`/`.tgz` — 시뮬레이터용 빌드. `.app.zip`은 [커맨드라인으로 빌드](https://developer.apple.com/library/archive/technotes/tn2339/_index.html)하고, `.tar.gz` 시뮬레이터 빌드는 그대로 올립니다.
- Android: `.apk`

::: warning iOS — `.ipa` 파일은 지원하지 않습니다
`.ipa`는 실제 기기용 포맷입니다. tapflow는 시뮬레이터용 `.app.zip`과 `.tar.gz`를 허용합니다. 업로드 오류가 발생하면 [문제 해결](/ko/guide/troubleshooting#ios-빌드-업로드-오류)을 참고하세요.
:::

업로드하면 bundle ID를 기준으로 App에 연결됩니다. 일치하는 App이 없으면 자동으로 생성됩니다. App을 먼저 만들어두고 빌드를 나중에 연결할 수도 있습니다.

CI 파이프라인에서 자동으로 업로드하는 방법은 [빌드 배포](/ko/guide/build-distribution)를 참고하세요.
