# 성능과 지연

이 페이지는 tapflow 스트리밍을 **실제로 측정한 기록**입니다. 같은 측정을 직접 돌려보려면 아래 [직접 재현하기](#reproduce)를 참고하세요.

::: tip 한 줄 요약
대역폭은 병목이 아니고(가정용 Wi-Fi의 한 자릿수 %만 사용), 디코드 지연은 LAN 실측 기준 한 자릿수~수십 ms입니다. 손가락에서 화면까지의 전체 체감(glass-to-glass)은 여기에 네트워크 왕복이 더해지며, 그 합은 사람이 "직접 조작한다"고 느끼는 한계로 알려진 ~100 ms<sup><a href="#ref-nielsen">1</a></sup> 예산 안에 들어가는 것으로 **추정**됩니다.
:::

## 측정 환경과 방법

tapflow는 코덱을 클라이언트마다 협상합니다. 실제 팀이 가장 많이 쓰는 경로는 **LAN(HTTP)** 이며, 이 경로는 보안 컨텍스트가 아니므로 브라우저가 **WASM(tinyh264) 소프트웨어 디코더**를 사용합니다. 따라서 이 페이지의 기준 수치는 이 WASM 경로입니다. HTTPS(보안 컨텍스트)에서는 하드웨어 가속 **WebCodecs**가 쓰여 더 빠르지만, 인증서 설정이 필요해 현재는 선택적 경로입니다.

두 가지 지표를 구분해서 봅니다.

| 지표 | 정의 | 유효 범위 |
|------|------|-----------|
| **decode→present** | 뷰어가 프레임을 받아 디코드해 화면에 그리기까지 | 모든 환경에서 유효 (한 머신 안의 시간 차) |
| **glass-to-glass** | 화면이 캡처된 순간부터 뷰어에 표시되기까지 | **단일 클럭(localhost)에서만 유효** |

`glass-to-glass`는 캡처 시각(에이전트 머신)과 표시 시각(뷰어 머신)의 뺄셈이라, 두 머신의 시계가 다른 LAN 환경에서는 직접 측정할 수 없습니다. 그래서 LAN에서는 어느 환경에서나 유효한 `decode→present`를 측정하고, 전체 체감은 [추정 섹션](#estimate)에서 다룹니다.

## 대역폭

H.264 스트림은 대역폭을 거의 쓰지 않습니다. 정지 화면은 거의 무시할 수준이고, 스크롤처럼 화면 전체가 바뀌는 최악의 경우에만 잠깐 올라갑니다.

| 시나리오 | 프레임당 | 대역폭 | JPEG 대비 |
|----------|----------|--------|-----------|
| 정지 | ~1.8 KB | ~14 KB/s | ~140× 절감 |
| 스크롤 | ~90–110 KB | ~2.6 MB/s | ~5× 절감 |

스크롤 피크 ~2.6 MB/s는 약 21 Mbps입니다. IEEE 802.11ac(Wi-Fi 5)의 단일 링크 처리량 규격이 **≥500 Mbps**<sup><a href="#ref-80211ac">2</a></sup>이고 기가비트 이더넷이 1 Gbps인 것을 감안하면, 가정용 Wi-Fi 한 대의 대역폭 중 한 자릿수 %만 사용합니다. **대역폭은 병목이 아닙니다.**

## 디코드 지연

LAN 실측입니다. 에이전트(빌드 머신)와 뷰어를 **서로 다른 Mac**에 두고 같은 LAN으로 연결한 뒤, 뷰어 쪽 WASM(tinyh264) 디코더의 `decode→present`를 4회 반복 측정한 평균입니다.

| 시나리오 | p50 | p95 |
|----------|-----|-----|
| 정지 | 11.3 ms | 43.9 ms |
| 스크롤 | 16.6 ms | 49.9 ms |

참고로, 네트워크 영향을 제거한 **localhost 단일 클럭**에서는 전체 `glass-to-glass`까지 측정할 수 있는데, WASM 경로가 정지 9.6 ms / 스크롤 16 ms로 localhost JPEG(직접 조작에 가장 가까운 기준선)와 동급이었습니다. 즉 디코드 자체는 네트워크가 0에 수렴할 때 한 자릿수~십수 ms가 하한입니다.

## 체감 지연 추정 {#estimate}

::: warning 추정치입니다 (측정값 아님)
아래는 측정된 `decode→present`에 공개된 네트워크 지연 규격을 더한 **구성요소 합산 추정**입니다. LAN의 `glass-to-glass`는 위에서 설명한 두 클럭 문제로 직접 측정할 수 없어, 단정하지 않습니다.
:::

손가락에서 화면까지의 전체 지연은 대략 다음으로 구성됩니다.

- **디코드** (LAN 실측): p50 11–17 ms, p95 ~44–50 ms
- **네트워크 왕복**: 유선 LAN <1 ms, Wi-Fi 6는 한 자릿수 ms 범위 — OFDMA 비포화 조건에서 중앙값이 5 ms 미만으로 보고됩니다<sup><a href="#ref-80211ax">3</a></sup>
- **캡처·인코드** (에이전트 측, localhost 실측): 에이전트→릴레이 ~1 ms, 그 위에 캡처 주기(iOS 30fps 폴링은 0–33 ms)

이 합을 **사람이 "직접 조작한다"고 느끼는 한계 ~100 ms**<sup><a href="#ref-nielsen">1</a></sup>와 비교하면, tapflow가 통제하는 디코드·전송 몫은 그 예산의 일부만 차지합니다. 같은 부류인 원격 인터랙티브 스트리밍(클라우드 게이밍)의 품질 연구들도 대체로 ~100 ms 부근을 쾌적함의 한계로 봅니다<sup><a href="#ref-cloudgaming">4</a></sup>.

정확한 값은 환경마다 다릅니다. 가장 정직한 방법은 **운영 중인 LAN에서 직접 `ping`을 재서** 위의 네트워크 항목에 넣어보는 것입니다.

## 알려진 한계

- LAN의 `glass-to-glass`는 에이전트와 뷰어가 서로 다른 시계를 쓰기 때문에 직접 측정할 수 없습니다. 위 체감 수치는 추정입니다.
- 스크롤 **p95가 ~50 ms**까지 오릅니다. 정지 화면보다 움직임이 큰 순간에는 예산이 빠듯해질 수 있습니다. 측정상 이 꼬리는 디코더가 아니라 부하·전송에서 옵니다.
- HTTPS(WebCodecs) 경로의 LAN 실측은 아직 없습니다. localhost 대용치(정지 3.9 ms / 스크롤 3.4 ms `glass-to-glass`)만 있습니다.
- 약 5%의 구형 브라우저(WebGL2 미지원)는 JPEG로 폴백합니다. 대역폭은 늘지만 동작합니다.
- 해상도 다운스케일은 화질을 일부 조정해 대역폭과 디코드 부하를 줄입니다(선택적, 기본은 네이티브).
- Android 에뮬레이터는 소프트웨어 H.264 인코더에 묶여 프레임 생산이 제한됩니다. 호스트 인코드 경로로 완화하며, 실제 단말은 하드웨어 인코더를 씁니다.

## 직접 재현하기 {#reproduce}

성능 계측은 개발 빌드(Vite `:3001`)에서만 켜지며, URL 쿼리로 디코더를 강제하고 `?perf=1` 패널에서 p50/p95를 읽습니다.

```sh
pnpm --filter @tapflowio/dashboard dev
```

브라우저에서 `?perf=1`과 `?decoder=`(`wasm` / `webcodecs` / `mse` / `jpeg`)를 붙여 티어별로 비교합니다. 크로스 머신 LAN 측정은 같은 LAN의 다른 Mac에서 뷰어를 띄워 진행합니다.

전체 파이프라인 분석, 디코더 선정 과정, 누적된 측정 로그와 결정 기록은 엔지니어링 로그에 그대로 남아 있습니다 — [streaming-latency-log.md](https://github.com/jo-duchan/tapflow/blob/main/contributing/streaming-latency-log.md).

## 참고 자료

1. <a name="ref-nielsen"></a> Jakob Nielsen, "Response Time Limits"(Nielsen Norman Group). 0.1초(100 ms)는 사용자가 UI 객체를 직접 조작한다고 느끼는 한계로, 즉각 반응의 환상을 만든다. <https://www.nngroup.com/articles/response-times-3-important-limits/>
2. <a name="ref-80211ac"></a> IEEE 802.11ac-2013. 단일 링크 ≥500 Mbps, 다중 스테이션 ≥1.1 Gbps. <https://en.wikipedia.org/wiki/IEEE_802.11ac-2013>
3. <a name="ref-80211ax"></a> "Experimental Evaluation of IEEE 802.11ax — Low Latency and High Reliability with Wi-Fi 6?"(IEEE) 및 "A First Look at Wi-Fi 6 in Action"(ACM). OFDMA가 비포화 조건에서 중앙값 지연을 ~5 ms에서 1 ms 미만으로 낮춘다. <https://ieeexplore.ieee.org/document/10001475/>
4. <a name="ref-cloudgaming"></a> 클라우드 게이밍의 체감 품질(QoE) 연구는 100 ms를 넘으면 품질이 저하되기 시작하는 것으로 본다(Jarschel et al., 2011). G. Illahi et al., "Cloud Gaming With Foveated Graphics"(arXiv:1809.05823) §4.3.2에서 인용. <https://arxiv.org/abs/1809.05823>
