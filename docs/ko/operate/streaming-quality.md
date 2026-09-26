# 스트림 품질

tapflow는 각 기기 화면을 H.264로 스트리밍하고 브라우저에서 디코딩합니다. 해상도와 디코더는 고정되어 있지 않으며, 각 시청자가 어떻게 접속했는지에 따라 화질과 디코딩 부하의 균형을 맞춰 세 가지 **프로파일** 중 하나를 자동으로 선택합니다.

프로파일은 사용자가 직접 고르지 않습니다. 릴레이 배포 방식과 시청자의 네트워크에 따라 결정되므로, 같은 기기라도 한 팀원에게는 localhost급 스트림을, 외부에 있는 다른 팀원에게는 대역폭을 줄인 스트림을 제공할 수 있습니다.

## 프로파일

| 프로파일 | 연결 유형 | 해상도 | 디코더 | 체감 |
|---------|-----------|--------|--------|------|
| **Standard** *(권장)* | LAN + HTTP | 1280px | WASM (tinyh264) | localhost에 준하는 반응 속도 |
| **Smooth** | LAN + HTTPS *(또는 localhost)* | 원본 해상도 | WebCodecs (하드웨어) | localhost급 |
| **Remote** | 외부 주소 | 1000px | WebCodecs (하드웨어), 평문 HTTP면 WASM | QA 가능한 임계 수준 |

**Standard**는 대부분의 팀이 일상적으로 쓰는 환경으로, LAN의 평문 HTTP 릴레이입니다. 브라우저가 WASM 소프트웨어 디코더로 H.264를 디코딩하기 때문에, tapflow는 디코딩 부하를 낮게 유지하면서도 반응 속도를 localhost에 가깝게 유지하기 위해 해상도를 1280px로 제한합니다.

**Smooth**는 tapflow가 제공할 수 있는 가장 나은 환경입니다. [secure 컨텍스트](https://developer.mozilla.org/ko/docs/Web/Security/Secure_Contexts)(LAN의 HTTPS 또는 localhost)에서는 브라우저가 WebCodecs를 사용할 수 있어 하드웨어로 디코딩하므로, 에이전트가 낮은 CPU 부하로 원본 해상도를 전송합니다.

**Remote**는 릴레이가 사설망이 아닌 주소(공인 IP 등)에서 온 연결로 보는 시청자를 위한 환경입니다. 대역폭이 제한적이라고 보고 해상도를 1000px로 낮춥니다. HTTPS면 하드웨어 디코딩이 유지되고 평문 HTTP면 WASM 디코더를 씁니다. QA에는 충분하지만 쾌적함의 경계 수준입니다.

## 배포 방식에 따른 프로파일

프로파일은 브라우저가 릴레이에 어떻게 도달하는지에 따라 결정되며, 이는 [릴레이 배포](/ko/operate/deployment) 시 선택하는 것과 정확히 같습니다.

| 배포 환경 | 프로파일 |
|-----------|---------|
| LAN에서 평문 HTTP로 릴레이 운영 | **Standard** |
| LAN에서 HTTPS로 릴레이 운영 | **Smooth** |
| 터널(VPS + rathole, `tailscale serve`)을 거친 HTTPS 접속 | **Smooth** |
| 공인 IP나 tailnet 주소(`100.x`)에서 릴레이 포트로 직접 접속 | **Remote** |

터널 클라이언트는 릴레이 Mac 안에서 loopback으로 연결하므로 릴레이는 터널로 들어온 시청자를 외부 주소로 구분하지 못합니다. 그래서 HTTPS 터널을 거친 시청자는 원본 해상도를 받습니다. 반대로 Tailscale의 tailnet 주소는 사설 대역 목록에 없어 외부 주소로 분류됩니다. 기본 Tailscale URL(평문 HTTP)로 접속하면 1000px 스트림을 WASM 디코더로 받습니다. 터널 사용자의 대역폭이 부족하면 아래 `TAPFLOW_MAX_SIZE`로 제한값을 직접 지정하세요.

공유 LAN을 **Standard**에서 **Smooth**로 올리려면 릴레이를 HTTPS로 제공하세요 — [tapflow 설정의 인증서 방식](/ko/operate/configure#_3-인증서-방식-smooth-선택-시)을 참고하세요.

::: tip HTTPS가 하드웨어 디코딩을 여는 이유
WebCodecs는 [secure 컨텍스트](https://developer.mozilla.org/ko/docs/Web/Security/Secure_Contexts)에서만 사용할 수 있습니다. LAN의 평문 HTTP는 secure가 아니므로 브라우저가 WASM 디코더로 폴백합니다. 그래서 **Standard**는 해상도를 제한하고, **Smooth**(HTTPS)는 제한하지 않습니다.
:::

## 해상도 튜닝

프로파일은 자동으로 선택되지만, 해상도 제한값은 직접 재정의할 수 있습니다. 에이전트가 실행되는 Mac에서 아래 환경변수를 설정하세요.

| 환경변수 | 기본값 | 설명 |
|---------|--------|------|
| `TAPFLOW_MAX_SIZE` | *(프로파일별)* | 전 플랫폼 공통 해상도 제한 (px, 가장 긴 변). `0`으로 설정하면 모든 연결에서 원본 해상도를 강제합니다. |
| `TAPFLOW_MAX_SIZE_LAN` | `1280` | Standard(LAN HTTP) 제한값 |
| `TAPFLOW_MAX_SIZE_EXTERNAL` | `1000` | Remote(외부) 제한값 |
| `TAPFLOW_IOS_MAX_SIZE` | *(프로파일별)* | iOS 전용 오버라이드. `TAPFLOW_MAX_SIZE`보다 우선 적용됩니다. |
| `TAPFLOW_ANDROID_MAX_SIZE` | *(프로파일별)* | Android 전용 오버라이드. `TAPFLOW_MAX_SIZE`보다 우선 적용됩니다. |
| `TAPFLOW_ANDROID_FPS` | `30` | Android 스트림의 프레임레이트 상한. |

스트림 품질은 에이전트와 릴레이 사이의 안정적이고 지연이 낮은 연결에도 좌우됩니다. 에이전트 배치와 네트워크 요구사항은 [에이전트 설정](/ko/operate/agents)을 참고하세요.
