# 스트리밍 저지연 캠페인 — tier1 = "직접 조작 대등"

> **북극성:** tier1(localhost + LAN)에서 **localhost-JPEG급 반응성**(브라우저에서 시뮬/에뮬을 직접 만지는 것과 거의 대등한 glass-to-glass 저지연)을 달성한다. 이게 tapflow의 핵심 가치(무설치·사용 편의·저지연 원격조작)의 시작이다.
>
> 이 문서는 **사라지지 않는 캠페인 로그**다. 파이프라인 분석 · 측정 수치 · 병목별 시도와 결과 · 결정을 **시간순으로 누적**한다. `.work/`(로컬·휘발)와 달리 커밋되어 영구 보존된다.
>
> 측정 도구: `TAPFLOW_STREAM_METRICS=1`(agent 처리량) · relay `ws backpressure`(드롭) · (예정) capture→display 지연 계측. 환경: LAN + HTTP / localhost, iPhone 16 Pro, macOS.

---

## 1. 문제 — 두 요구를 동시에

"wow"(직접 조작 대등)에는 **둘 다** 필요하다:
1. **저지연**(반응성) — 쓸어넘기면 화면이 즉시 따라옴.
2. **무드롭**(매끈) — 백프레셔 드롭으로 인한 찢김 없음.

지금까지 어느 경로도 둘을 동시에 못 줬다:

| 경로 | 지연 | 드롭(대역폭) |
|------|------|--------------|
| **JPEG** | ✅ 낮음 (프레임 독립·즉시 디코드) | ❌ 큼 → LAN 스크롤 relay 드롭 16–27/s (찢김) |
| **H.264** | ❌ 높음 (인코더+HW디코더 파이프라인, LAN은 +MSE 버퍼) | ✅ 작음 → 드롭 1–11/s |

→ **localhost-JPEG만 기준(wow)을 만족.** LAN-JPEG=찢김, H.264(local/LAN)=지연으로 기준치 미달.

---

## 2. 파이프라인 & 병목 (glass-to-glass)

| 단계 | JPEG | H.264 (우리) | 클라우드 게이밍 |
|------|------|--------------|------------------|
| 터치 전송 (브라우저→relay→agent→HID) | 동일 | 동일 | 동일 |
| 시뮬레이터 스크롤 렌더 | 동일 (시뮬 고유) | 동일 | — |
| 캡처 (30fps 폴링) | 0–33ms | 0–33ms | — |
| 인코더 파이프 | 0 (즉시) | VT (MaxFrameDelayCount=0로 최소화) | NVENC 저지연 프리셋 |
| **전송 + 버퍼** | 즉시 | **LAN = MSE 미디어버퍼 ← 핵심 villain** | UDP/WebRTC 미니 지터버퍼 |
| 디코더 | createImageBitmap 즉시 | WebCodecs(저지연) / **MSE(버퍼)** | HW 저지연 디코드 |

**핵심 통찰:**
- 병목은 "H.264 vs JPEG"가 아니라 **디코드/전송 경로**다. **클라우드 게이밍이 H.264로 glass-to-glass <50ms를 내는 게 존재 증명** — H.264는 저대역폭+저지연을 동시에 낼 수 있다.
- **LAN-HTTP에서 MSE를 쓴다는 게 진짜 문제.** MSE는 본질이 버퍼링이라 구조적 지연. 클라우드 게이밍은 MSE를 안 쓴다.
- **왜 MSE에 갇혔나 = secure context 벽:** WebCodecs(버퍼0·HW)는 HTTPS/localhost에서만 동작 → LAN-HTTP는 비secure라 MSE로 강등.

---

## 3. 디코더 tier 모델 (목표)

`pickDecoder`가 환경별로 자동 선택. **WASM이 빠진 조각** — LAN-HTTP의 MSE를 대체:

| tier | 환경 | 디코더 | 특성 |
|------|------|--------|------|
| 2 | HTTPS / localhost | WebCodecs | HW, 최저지연 |
| **1** | **LAN-HTTP** | **WASM (tinyh264)** ⬅️ 목표 | CPU, 저지연·버퍼0 (secure 불필요) |
| fallback | 그 외 | MSE | 버퍼(지연) |

WASM이 매력적인 이유: **secure context 불필요 + 미디어버퍼 없음** = JPEG의 즉시성 + H.264의 저대역폭을 LAN-HTTP에서 동시에. 대가는 **소프트웨어(CPU) 디코드** — 해상도×fps가 높으면 CPU 한계. 완화: **인코딩 해상도 다운스케일**(표시는 작음 → 대역폭·CPU·지연 삼중↓). 선례: ws-scrcpy가 tinyh264로 폰 해상도 baseline H.264 디코드.

---

## 4. 측정 로그 (누적)

### JPEG 베이스라인 (LAN, throughput sampler)

| 시나리오 | 품질 | avg/frame | 대역폭 | relay 드롭/초 |
|----------|------|-----------|--------|---------------|
| 정지 | 0.95 | 427 KB | ~3.3 MB/s | 0 (localhost 착시) |
| 정지 | 0.8 | 235 KB | ~1.97 MB/s | 0 |
| 스크롤 | 0.8 | ~590 KB | 12–16 MB/s | **16–27** |

### H.264 (VideoToolbox, steady 30fps)

| 시나리오 | avg/frame | 대역폭 | relay 드롭/초 |
|----------|-----------|--------|---------------|
| 정지 | ~1.8 KB | ~14 KB/s (**~140x↓** vs JPEG) | 0 |
| 스크롤 | ~90–110 KB | ~2.6 MB/s (**~5x↓**) | **1–11** |

→ H.264는 **대역폭/드롭은 압도적으로 해결**. 그러나 **체감 지연은 JPEG보다 나쁨**(아래).

### 지연 (체감, 정성)

| 경로 | 체감 |
|------|------|
| localhost JPEG | **기준(wow)** — 직접 조작 대등 |
| localhost H.264 (WebCodecs) | 반박자 지연 — 기준치 미달 |
| LAN JPEG | 반응 빠르나 스크롤 찢김 |
| LAN H.264 (MSE) | 드롭 0에 가깝지만 지연 가장 큼 |

> ⚠️ **정밀 per-stage 지연(ms)은 아직 미측정.** 캠페인 0단계에서 capture→display + 인코더 시간을 실측해 병목을 수치로 랭킹한다. (특히 *왜 localhost-WebCodecs-H.264조차 JPEG에 미달인가* — 인코더/디코더/표시경로 중 어디인지)

### per-stage 지연 (0단계 계측 — 2026-06-02 실측, localhost)

`?perf=1` 패널의 `p50/p95 ms` 폴더 + `[wc-diag]`(정확 timestamp 매칭) 콘솔에서 읽음.

| 경로 | decode→present p50/p95 | glass→glass p50/p95 | agent→relay | 비고 |
|------|----------------------:|--------------------:|------------:|------|
| JPEG 정지 | 12.4 / 15.4 | (≈13)* | 1 | wow 기준선 |
| JPEG 스크롤 | 9.4 / 11.6 | (≈11)* | 1 | |
| **H.264 정지 (수정 전)** | **267 / 274** | **235 / 239** | 0–1 | 디코더가 ~8프레임 버퍼 |
| **H.264 정지 (수정 후)** | **2.5 / 4** | **3.9 / 7.9** | 0–1 | reorder=0 주입 |
| **H.264 스크롤 (수정 후)** | **2.1 / 3.9** | **3.4 / 7.9** | 0–1 | |

→ **수정으로 decode→present 267→2.5ms (~100x↓), glass→glass 235→3.5ms.** H.264 glass→glass(~3.5ms)가 JPEG decode(~10–12ms)보다 **빠름** — 지연·대역폭 양쪽에서 JPEG 추월. **북극성(localhost-JPEG급) 도달.**

> \* JPEG glass→glass는 패널 미산출(`null`) — H.264 tracker 경로에서만 계산. decode(~10ms)+agent→relay(~1ms)로 ≈11–13ms.
> **clock 유효성:** glass→glass = present(epoch) − capturedAt → **localhost 단일 클럭에서만**. decode→present(델타)·agent→relay(둘 다 Mac)는 모든 환경 유효.
> **근본 원인:** iOS 인코더 SPS가 `bitstream_restriction`을 안 박음(VUI 확인: `bitstreamRestriction:false`, Level 5.0). 디코더가 레벨 max DPB(110400/~13800MB ≈ 8프레임)만큼 안전 버퍼링 → 267ms. baseline(66)이라 실제 리오더는 0인데 **신호만 누락**. → SPS에 `max_num_reorder_frames=0` 선언 주입으로 해결.

---

## 5. 캠페인 로드맵 (측정 게이트로 연결)

각 단계는 **측정으로 효과 확인 후 다음**. 안 되면 롤백/재설계.

| # | 단계 | 목적 | 상태 |
|---|------|------|------|
| **0** | per-stage 지연 계측 (capture→display, 인코더 시간) | 병목 수치 랭킹. localhost-WebCodecs-H.264 부검 | ✅ 완료 — 범인=SPS reorder 미선언 |
| **1** | SPS reorder=0 주입으로 디코더 DPB 버퍼 제거 | WebCodecs를 localhost-JPEG급으로 | ✅ WebCodecs 검증(267→2.5ms). ⬜ 인코더 이전(MSE/WASM 혜택) |
| 2 | **WASM 디코더(tinyh264)** → LAN-HTTP MSE 대체 | 버퍼0·secure불필요 → LAN 저지연 | ☐ |
| 3 | 인코딩 해상도 다운스케일 | 대역폭·CPU·지연 삼중↓ | ☐ |
| 4 | 캡처 이벤트화/고fps, 터치 경로 최적화 | 바닥 더 깎기 | ☐ |

### 기반 (완료/진행)
- H.264 인코더 (VideoToolbox, baseline, MaxFrameDelayCount=0, steady cadence, BT.709) — ios-agent, 옵트인 `TAPFLOW_IOS_CODEC=h264`.
- envelope 코덱/키프레임 마커 (byte5) — relay 키프레임 인지 드롭(PR-D, 보류) 대비.
- 디코더 계층 `pickDecoder`(WebCodecs/MSE) + IOSViewer가 video 직접 표시 + WebCodecs 멀티-NAL 디코드.

---

## 6. 측정 방법 (재현)

```bash
TAPFLOW_STREAM_METRICS=1 TAPFLOW_IOS_CODEC=h264 pnpm dev     # H.264
TAPFLOW_STREAM_METRICS=1                       pnpm dev     # JPEG(기본)
TAPFLOW_STREAM_METRICS=1 TAPFLOW_JPEG_QUALITY=0.95 pnpm dev  # JPEG 품질 비교
```

| 읽는 곳 | 로그 | 의미 |
|---------|------|------|
| **ios-agent** | `stream metrics ... NNfps NNKB/s avg=NNKB drop=N%` | 인코더 출력(원인) — 대역폭·평균 프레임 |
| **relay** | `ws backpressure: N frame(s) dropped` | LAN 실제 드롭(결과). drop은 relay→browser 홉 |

#### per-stage 지연 패널 (0단계)

브라우저에서 `?perf=1`로 perf 오버레이를 띄운다 (`Ctrl+Shift+P` 토글). `tweakpane`의 `p50/p95 ms` 폴더에 **glass→glass · decode→present · agent→relay** 가 실시간으로 뜬다. `Log latency summary` 버튼은 현재 누적 트레이스의 요약(JSON)을 콘솔에 찍어 §4 표에 붙여넣게 한다. `Export trace`는 `chrome://tracing` 호환 trace로 내보낸다.

```bash
# 0단계 부검은 localhost(단일 클럭)에서. Vite :3001 = DEV 빌드라 계측이 켜진다.
TAPFLOW_IOS_CODEC=h264 pnpm dev   # :3001?perf=1 → H.264 per-stage
                       pnpm dev   # :3001?perf=1 → JPEG 기준선
```

> ⚠️ **계측은 DEV 빌드 전용**(`import.meta.env.DEV`). Vite 개발 서버(`:3001`)에서만 켜지고, **빌드된 LAN(`:4000`)에는 없다.** 0단계는 localhost 단일-클럭 부검이라 `:3001`이 정확히 맞는 환경 — glass→glass도 여기서만 유효하다.

> **LAN 테스트 주의:** LAN(`:4000`)은 relay가 빌드된 `packages/relay/public/`를 서빙한다. 대시보드 소스 변경은 `pnpm --filter @tapflowio/dashboard build` 후 `:4000` 새로고침해야 반영된다 (Vite `:3001`은 localhost 전용).

---

## 7. 결정 로그 (시간순 누적)

- **2026-06-02 — H.264 마이그레이션 (Phase 2):** JPEG 풀프레임 대역폭 문제 확정(정지 3.3MB/s, LAN 스크롤 드롭 16–27/s) → VideoToolbox H.264 도입. 대역폭은 ~140x(정지)/~5x(스크롤) 해결, 드롭 거의 제거.
- **2026-06-02 — 그러나 지연 발견:** H.264는 코덱 파이프라인 + LAN MSE 버퍼로 **JPEG보다 반응 느림**. localhost-JPEG가 "직접 조작 대등" 기준임을 확립. → "H.264로 갈아타기"가 아니라 **"저지연 디코드/전송 경로"가 진짜 과제**로 재정의.
- **2026-06-02 — 캠페인 시작:** 측정 기반으로 병목을 하나씩. WASM 디코더(tier1 LAN-HTTP)를 핵심 레버로. PR-D(drop-to-keyframe)는 MSE 이탈 가능성으로 보류.
- **2026-06-02 — 0단계 부검 완료 + 1단계 검증 (핵심 돌파):** localhost-WebCodecs-H.264 지연 ~267ms의 범인 확정 — 전송/relay(~1ms)·입력 백로그(queueSize=0) 모두 무죄, **디코더가 max DPB(~8프레임) 버퍼링**. SPS VUI 파싱으로 `bitstreamRestriction:false`(Level 5.0) 확인 → 인코더가 "리오더 0"을 안 알려줘 디코더가 최악 가정. baseline이라 실제 리오더는 0인 **순수 신호 누락**. **수정:** WebCodecsCore가 configure 직전 SPS에 `max_num_reorder_frames=0`/`max_dec_frame_buffering=num_ref` 주입(`rewriteSpsLowLatency`). **결과: decode→present 267→2.5ms(~100x), glass→glass 235→3.5ms, 체감 localhost-JPEG급 도달.** 다음: 이 SPS 수정을 ios-agent로 이전해 MSE/LAN/WASM 전 경로가 혜택받게 한다(현재는 WebCodecs 경로만).
- **2026-06-02 — 0단계 계측 착수:** 기존 `perf` 시스템(`?perf=1`, FrameTiming, trace export)을 **재활용**(신규 샘플러 폐기). 핵심 공백은 H.264 경로가 `decodeMs/paintMs=0`으로 찍히던 것 — 디코더 surface로 fire-and-forget이라 부검 대상이 사각지대였음. 해결: Decoder에 `onDecodedFrame`(WebCodecs=output 콜백, MSE=`requestVideoFrameCallback`) 추가 + `FrameLatencyTracker`(submit↔present FIFO 상관, **baseline·B-frame OFF라 재정렬 없음→정확**)로 decode→present·glass→glass 복원. glass→glass는 epoch present−capturedAt이라 **localhost 단일 클럭에서만** 산출. 프로토콜/envelope 불변, 인터페이스 변경은 dashboard 내부(비 breaking). 측정 수치는 §4에 누적.
