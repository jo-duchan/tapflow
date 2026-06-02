# iOS 스트리밍 — 풀프레임 JPEG → H.264 (Phase 2)

> iOS 시뮬레이터 화면 전송을 풀프레임 JPEG에서 VideoToolbox H.264로 전환한 배경·측정·방법 기록.
> 측정 환경: LAN + HTTP, iPhone 16 Pro, macOS. 측정 도구: `TAPFLOW_STREAM_METRICS=1`(agent 처리량 로그) + relay `ws backpressure` 로그.

---

## 왜 JPEG가 문제였나 (측정)

iOS는 SimulatorKit IOSurface 스냅샷을 **프레임마다 풀스크린 JPEG로 인코딩**해 전송한다. 화면 변화 유무와 무관하게 매 프레임 전체를 다시 보내므로, **정지 화면조차 대역폭을 크게 소비**한다.

`createThroughputSampler`(agent-core)로 계측한 JPEG 베이스라인:

| 시나리오 | 품질 | avg/frame | 대역폭 | relay 드롭/초 (LAN) |
|----------|------|-----------|--------|---------------------|
| 정지 | 0.95 | 427 KB | ~3.3 MB/s (26 Mbps) | 0 (localhost 착시) |
| 정지 | 0.8 | 235 KB | ~1.97 MB/s | 0 |
| 스크롤 | 0.8 | ~590 KB | 12–16 MB/s (peak 22) | **9–23** |
| 애니메이션 | 0.8 | ~210 KB | 2–8.7 MB/s | 1–20 |

핵심:
- **정지 화면 3.3 MB/s** — 변화가 없는데도 풀프레임 재전송. 순수 낭비.
- **`drop=0%`는 localhost 착시.** 루프백은 대역폭이 사실상 무한이라 백프레셔(`bufferedAmount ≥ 1MB`)에 안 걸린다. LAN+HTTP에선 스크롤 12–16 MB/s가 WiFi 실효 대역(보통 50–150 Mbps)을 초과해 **relay→browser에서 매초 9–23 프레임 드롭** → 터치 이벤트 중첩·화면 튐.
- **품질 노브(0.95→0.8)는 부분 완화일 뿐.** 정지/단순 화면은 ~45% 줄지만, 고엔트로피 스크롤은 ~15%만 줄어 드롭이 잔존한다. 드롭이 나는 케이스를 못 잡음.

> 결론: 병목은 transport(TCP WebSocket은 충분히 빠름)가 아니라 **프레임 크기(풀프레임 JPEG)**. 구조적 해결 = 프레임 간 차분(P-frame)을 보내는 H.264.

---

## H.264 전환 (Phase 2)

agent는 `TAPFLOW_IOS_CODEC=h264`일 때 `VTCompressionSession`(VideoToolbox)으로 인코딩한다.

- **인코더**: H.264 baseline, B-frame off, `RealTime=true`(저지연), 주기적 IDR(2초), 색공간 BT.709(디자인 색 충실도 유지).
- **출력**: IOSurface(BGRA) → CVPixelBuffer → 인코더. AVCC 길이접두 NAL → Annex B 변환, 키프레임엔 SPS+PPS 선부착.
- **프레이밍**: `[4-byte len][flags:u8][Annex B NAL]`. flags bit0 = keyframe. (JPEG 경로는 `[len][jpeg]` 그대로.)
- **envelope 마커**(TFFE byte5): bit0 = 코덱(0=JPEG/1=H264), bit1 = keyframe. relay/브라우저가 페이로드 파싱 없이 코덱·키프레임 판별.
- **브라우저 디코드**: Phase 1의 `pickDecoder` 재사용 — secure context면 WebCodecs, LAN+HTTP면 MSE(jmuxer). iOS도 동일 계층 사용. JPEG는 fallback 유지.
- **드롭 정책**(예정, PR-D): H.264는 프레임 간 의존이라 임의 드롭 시 다음 IDR까지 깨진다. relay가 envelope keyframe 플래그로 **drop-to-keyframe** 처리.

---

## 측정 방법 (재현)

```bash
# agent 처리량 로그(정지/동적 대역폭·드롭률) + 코덱 선택
TAPFLOW_STREAM_METRICS=1 TAPFLOW_IOS_CODEC=h264 pnpm dev     # h264
TAPFLOW_STREAM_METRICS=1                       pnpm dev     # jpeg(기본)
TAPFLOW_STREAM_METRICS=1 TAPFLOW_JPEG_QUALITY=0.95 pnpm dev  # jpeg 품질 비교
```

| 읽는 곳 | 로그 | 의미 |
|---------|------|------|
| **ios-agent** | `stream metrics ... NNfps NNKB/s avg=NNKB drop=N%` | 인코더 출력(원인) — 대역폭·평균 프레임 크기 |
| **relay** | `ws backpressure: N frame(s) dropped` | LAN 실제 드롭(결과). agent→relay는 동일 Mac이라 ~0, 드롭은 relay→browser에서 발생 |

> 시나리오별 30초 이상 안정 구간을 읽는다. 정지/스크롤/애니메이션을 같은 환경(localhost 또는 LAN+HTTP)에서 비교.

---

## 결과 — JPEG vs H.264

| 시나리오 | JPEG(0.8) | **H.264** | 개선 |
|----------|-----------|-----------|------|
| 정지 KB/s | ~1,970 (26 Mbps) | **~14 (0.11 Mbps)** | **~140배 ↓** |
| 정지 avg/frame | 235 KB | **~1.8 KB** | **~130배 ↓** |
| 스크롤 KB/s | 12–16 MB/s | _측정 예정 (E2E)_ | _목표 2–4 MB/s_ |
| 스크롤 relay 드롭/초 | 9–23 | _측정 예정 (E2E)_ | _목표 ~0_ |

- **정지 화면 대역폭 26 Mbps → 0.11 Mbps (~140배).** P-frame이 풀프레임 재전송 낭비를 제거. 정지 윈도우가 14↔6 KB/s로 오가는 건 2초 IDR이 끼는 윈도우 vs 순수 P-frame 윈도우의 차이.
- 스크롤(동적) 수치는 PR-C(브라우저 디코드) E2E 측정 후 채운다.

> H.264의 런타임 비용은 오히려 낮다(HW 인코더). 트레이드오프는 개발 복잡도(VideoToolbox 인코딩 + drop-to-keyframe).
