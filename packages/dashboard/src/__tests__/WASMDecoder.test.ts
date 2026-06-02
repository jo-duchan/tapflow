import { describe, it, expect, vi } from 'vitest'
import { WASMDecoder } from '@/lib/decoders/WASMDecoder'
import type { YUVRenderer } from '@/lib/decoders/WASMDecoder'

// Mock worker: records postMessage (+transfer list), exposes emit() to simulate
// worker→main messages. Real tinyh264 Worker + WASM are never instantiated in tests.
function mockWorker() {
  return {
    posted: [] as { msg: Record<string, unknown>; transfer?: Transferable[] }[],
    terminated: false,
    onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage(msg: Record<string, unknown>, transfer?: Transferable[]) {
      this.posted.push({ msg, transfer })
    },
    terminate() { this.terminated = true },
    emit(data: unknown) { this.onmessage?.({ data } as MessageEvent) },
  }
}

function mockRenderer(): YUVRenderer & { drawn: { len: number; w: number; h: number }[]; disposed: boolean } {
  return {
    drawn: [],
    disposed: false,
    init() { return true },
    drawI420(data: Uint8Array, w: number, h: number) {
      this.drawn.push({ len: data.length, w, h })
      return { width: w, height: h }
    },
    dispose() { this.disposed = true },
  }
}

function setup() {
  const worker = mockWorker()
  const renderer = mockRenderer()
  const d = new WASMDecoder(() => renderer, () => worker as unknown as Worker)
  return { d, worker, renderer }
}

function picture(w: number, h: number) {
  return { type: 'pictureReady', width: w, height: h, data: new Uint8Array(w * h * 3 / 2).buffer, renderStateId: 0 }
}

describe('WASMDecoder — decode buffering until decoderReady', () => {
  it('decoderReady 전 decode는 버퍼링되고 worker로 안 보냄', () => {
    const { d, worker } = setup()
    d.decode(new Uint8Array([1, 2, 3]).buffer)
    expect(worker.posted).toHaveLength(0)
  })

  it('decoderReady 수신 시 버퍼된 프레임을 flush한다', () => {
    const { d, worker } = setup()
    d.decode(new Uint8Array([1, 2, 3]).buffer)
    d.decode(new Uint8Array([4, 5]).buffer)
    worker.emit({ type: 'decoderReady' })
    expect(worker.posted).toHaveLength(2)
    expect(worker.posted[0].msg.type).toBe('decode')
    expect(worker.posted[0].msg.length).toBe(3)
    expect(worker.posted[1].msg.length).toBe(2)
  })

  it('ready 이후 decode는 즉시 전송 + 버퍼 transfer', () => {
    const { d, worker } = setup()
    worker.emit({ type: 'decoderReady' })
    const buf = new Uint8Array([7, 8, 9, 10]).buffer
    d.decode(buf)
    expect(worker.posted).toHaveLength(1)
    expect(worker.posted[0].msg).toMatchObject({ type: 'decode', offset: 0, length: 4, renderStateId: 0 })
    expect(worker.posted[0].transfer).toEqual([buf]) // zero-copy 전송
  })
})

describe('WASMDecoder — pictureReady 렌더', () => {
  it('YUV 프레임을 렌더러로 그리고 size를 갱신한다', () => {
    const { d, worker, renderer } = setup()
    worker.emit({ type: 'decoderReady' })
    worker.emit(picture(4, 2))
    expect(renderer.drawn).toEqual([{ len: 12, w: 4, h: 2 }]) // 4*2*3/2=12
    expect(d.size).toEqual({ width: 4, height: 2 })
  })

  it('첫 프레임/치수 변경 시 onResize 콜백을 1회 발화한다', () => {
    const { d, worker } = setup()
    const onResize = vi.fn()
    d.onResize(onResize)
    worker.emit({ type: 'decoderReady' })
    worker.emit(picture(640, 480))
    worker.emit(picture(640, 480)) // 동일 치수 → 추가 호출 없음
    worker.emit(picture(480, 640)) // 회전 → 재발화
    expect(onResize).toHaveBeenCalledTimes(2)
    expect(onResize).toHaveBeenLastCalledWith({ width: 480, height: 640 })
  })

  it('pictureReady마다 onDecodedFrame(present 시각)을 발화한다', () => {
    const { d, worker } = setup()
    const onFrame = vi.fn()
    d.onDecodedFrame(onFrame)
    worker.emit({ type: 'decoderReady' })
    worker.emit(picture(4, 2))
    expect(onFrame).toHaveBeenCalledOnce()
    expect(typeof onFrame.mock.calls[0][0]).toBe('number') // presentTime
  })
})

describe('WASMDecoder — surface / close', () => {
  it('surface는 canvas다', () => {
    const { d } = setup()
    expect(d.surface).toBeInstanceOf(HTMLCanvasElement)
  })

  it('close는 worker.terminate + renderer.dispose', () => {
    const { d, worker, renderer } = setup()
    d.close()
    expect(worker.terminated).toBe(true)
    expect(renderer.disposed).toBe(true)
  })
})
