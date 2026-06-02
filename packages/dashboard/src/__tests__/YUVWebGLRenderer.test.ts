import { describe, it, expect } from 'vitest'
import { YUVWebGLRenderer } from '@/lib/YUVWebGLRenderer'

// ── WebGL2 목 (jsdom은 webgl2 컨텍스트를 제공하지 않음) ──────────────────────
// WebGLVideoRenderer.test.ts와 동일 패턴: Proxy로 gl.* 호출을 기록, 상수는 이름
// 문자열로, create*는 truthy 객체로 반환. 실제 픽셀 색(BT.709 변환)은 GL이 없어
// 검증 불가 → 브라우저 컬러피커 시각검증(캠페인 방법론). 여기선 배선·평면분할 검증.
function mockGL(throwOn?: string) {
  const calls: Record<string, unknown[][]> = {}
  const gl = new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined
      if (/^[A-Z0-9_]+$/.test(prop)) return prop // GL 상수
      return (...args: unknown[]) => {
        ;(calls[prop] ??= []).push(args)
        if (prop === throwOn) throw new Error(`GL ${prop} threw`)
        if (prop.startsWith('create')) return { tag: prop }
        if (prop === 'getAttribLocation' || prop === 'getUniformLocation') return 0
        return undefined
      }
    },
  })
  return { gl, calls }
}

function mockCanvas(gl: unknown | null): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    getContext: (type: string) => (type === 'webgl2' ? gl : null),
  } as unknown as HTMLCanvasElement
}

// Combined I420 buffer: Y(w*h) + U(cw*ch) + V(cw*ch), cw=ceil(w/2), ch=ceil(h/2).
function i420(width: number, height: number): Uint8Array {
  const cw = (width + 1) >> 1
  const ch = (height + 1) >> 1
  return new Uint8Array(width * height + 2 * cw * ch)
}

describe('YUVWebGLRenderer — init', () => {
  it('WebGL2 미지원(getContext null)이면 init()=false', () => {
    expect(new YUVWebGLRenderer(mockCanvas(null)).init()).toBe(false)
  })

  it('WebGL2 컨텍스트가 있으면 init()=true', () => {
    expect(new YUVWebGLRenderer(mockCanvas(mockGL().gl)).init()).toBe(true)
  })
})

describe('YUVWebGLRenderer — drawI420', () => {
  it('프레임 크기를 반환한다', () => {
    const r = new YUVWebGLRenderer(mockCanvas(mockGL().gl))
    r.init()
    expect(r.drawI420(i420(100, 200), 100, 200)).toEqual({ width: 100, height: 200 })
  })

  it('치수가 바뀌면 캔버스를 리사이즈한다', () => {
    const canvas = mockCanvas(mockGL().gl)
    const r = new YUVWebGLRenderer(canvas)
    r.init()
    r.drawI420(i420(640, 480), 640, 480)
    expect(canvas.width).toBe(640)
    expect(canvas.height).toBe(480)
  })

  it('Y/U/V 3개 평면을 올바른 치수·서브배열로 업로드한다', () => {
    const { gl, calls } = mockGL()
    const r = new YUVWebGLRenderer(mockCanvas(gl))
    r.init()
    const w = 4, h = 2 // ySize=8, chroma 2x1 → 각 2바이트
    r.drawI420(i420(w, h), w, h)

    expect(calls.texImage2D).toHaveLength(3)
    // texImage2D(target, level, internalformat, width, height, border, format, type, pixels)
    const [y, u, v] = calls.texImage2D
    expect([y[3], y[4], (y[8] as Uint8Array).length]).toEqual([4, 2, 8]) // Y: w×h
    expect([u[3], u[4], (u[8] as Uint8Array).length]).toEqual([2, 1, 2]) // U: cw×ch
    expect([v[3], v[4], (v[8] as Uint8Array).length]).toEqual([2, 1, 2]) // V: cw×ch
    expect(calls.drawArrays).toBeDefined()
  })

  it('홀수 치수에서 chroma는 ceil(w/2)·ceil(h/2)', () => {
    const { gl, calls } = mockGL()
    const r = new YUVWebGLRenderer(mockCanvas(gl))
    r.init()
    const w = 5, h = 3 // cw=3, ch=2
    r.drawI420(i420(w, h), w, h)
    const [, u] = calls.texImage2D
    expect([u[3], u[4], (u[8] as Uint8Array).length]).toEqual([3, 2, 6])
  })

  it('init 전 drawI420은 null 반환(throw 안 함)', () => {
    const r = new YUVWebGLRenderer(mockCanvas(mockGL().gl)) // init 미호출
    expect(r.drawI420(i420(100, 200), 100, 200)).toBeNull()
  })
})

describe('YUVWebGLRenderer — dispose', () => {
  it('GPU 리소스를 해제한다(텍스처 3개/vao/program)', () => {
    const { gl, calls } = mockGL()
    const r = new YUVWebGLRenderer(mockCanvas(gl))
    r.init()
    r.dispose()
    expect(calls.deleteTexture).toHaveLength(3)
    expect(calls.deleteVertexArray).toBeDefined()
    expect(calls.deleteProgram).toBeDefined()
  })

  it('init 안 된 상태에서 dispose는 throw 안 함', () => {
    const r = new YUVWebGLRenderer(mockCanvas(null))
    r.init()
    expect(() => r.dispose()).not.toThrow()
  })
})
