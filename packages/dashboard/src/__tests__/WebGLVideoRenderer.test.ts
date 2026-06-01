import { describe, it, expect, vi } from 'vitest'
import { WebGLVideoRenderer } from '@/lib/WebGLVideoRenderer'

// ── WebGL2 목 (jsdom은 webgl2 컨텍스트를 제공하지 않음) ──────────────────────
// Proxy로 모든 gl.* 호출을 기록하고, 상수는 이름 문자열로, create*는 truthy 객체로 반환.
function mockGL() {
  const calls: Record<string, unknown[][]> = {}
  const gl = new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined
      if (/^[A-Z0-9_]+$/.test(prop)) return prop // GL 상수
      return (...args: unknown[]) => {
        ;(calls[prop] ??= []).push(args)
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

function mockFrame(w: number, h: number): VideoFrame {
  return { displayWidth: w, displayHeight: h, close: vi.fn() } as unknown as VideoFrame
}

// ── init ──────────────────────────────────────────────────────────────────────
describe('WebGLVideoRenderer — init', () => {
  it('WebGL2 미지원(getContext null)이면 init()=false', () => {
    const r = new WebGLVideoRenderer(mockCanvas(null))
    expect(r.init()).toBe(false)
  })

  it('WebGL2 컨텍스트가 있으면 init()=true', () => {
    const r = new WebGLVideoRenderer(mockCanvas(mockGL().gl))
    expect(r.init()).toBe(true)
  })
})

// ── drawFrame ─────────────────────────────────────────────────────────────────
describe('WebGLVideoRenderer — drawFrame', () => {
  it('프레임 크기를 반환한다', () => {
    const r = new WebGLVideoRenderer(mockCanvas(mockGL().gl))
    r.init()
    expect(r.drawFrame(mockFrame(100, 200))).toEqual({ width: 100, height: 200 })
  })

  it('GPU 메모리 누수 방지를 위해 frame.close()를 호출한다', () => {
    const r = new WebGLVideoRenderer(mockCanvas(mockGL().gl))
    r.init()
    const frame = mockFrame(100, 200)
    r.drawFrame(frame)
    expect(frame.close).toHaveBeenCalledOnce()
  })

  it('프레임 치수가 바뀌면 캔버스를 리사이즈한다', () => {
    const canvas = mockCanvas(mockGL().gl)
    const r = new WebGLVideoRenderer(canvas)
    r.init()
    r.drawFrame(mockFrame(640, 480))
    expect(canvas.width).toBe(640)
    expect(canvas.height).toBe(480)
  })

  it('프레임을 텍스처로 업로드(texImage2D)하고 drawArrays로 렌더한다', () => {
    const { gl, calls } = mockGL()
    const r = new WebGLVideoRenderer(mockCanvas(gl))
    r.init()
    const frame = mockFrame(100, 200)
    r.drawFrame(frame)
    expect(calls.texImage2D).toBeDefined()
    expect(calls.texImage2D[0][5]).toBe(frame) // 마지막 인자 = VideoFrame
    expect(calls.drawArrays).toBeDefined()
  })

  it('init 전 drawFrame은 frame.close 후 null 반환(throw 안 함)', () => {
    const r = new WebGLVideoRenderer(mockCanvas(mockGL().gl)) // init 미호출
    const frame = mockFrame(100, 200)
    expect(r.drawFrame(frame)).toBeNull()
    expect(frame.close).toHaveBeenCalledOnce()
  })
})

// ── dispose ───────────────────────────────────────────────────────────────────
describe('WebGLVideoRenderer — dispose', () => {
  it('GPU 리소스를 해제한다(texture/vao/program)', () => {
    const { gl, calls } = mockGL()
    const r = new WebGLVideoRenderer(mockCanvas(gl))
    r.init()
    r.dispose()
    expect(calls.deleteTexture).toBeDefined()
    expect(calls.deleteVertexArray).toBeDefined()
    expect(calls.deleteProgram).toBeDefined()
  })

  it('init 안 된 상태에서 dispose는 아무 일도 안 한다(throw 안 함)', () => {
    const r = new WebGLVideoRenderer(mockCanvas(null))
    r.init()
    expect(() => r.dispose()).not.toThrow()
  })
})
