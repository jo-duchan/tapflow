import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import type { WebSocket as WsType } from 'ws'
import {
  registerStreamWs,
  sendBinaryWithBackpressure,
  createKeyframeAwareSender,
  createRateLimitedDropWarn,
  sendAudioYieldingToVideo,
  AUDIO_BUFFER_CEILING_BYTES,
  DEFAULT_BACKPRESSURE_BYTES,
} from '../utils/stream'
import type { Logger } from '../logger'

function makeMockWs(props?: { readyState?: number; bufferedAmount?: number }): WsType & EventEmitter {
  const emitter = new EventEmitter()
  const ws = Object.assign(emitter, {
    send: vi.fn(),
    readyState: props?.readyState ?? 1, // OPEN
    bufferedAmount: props?.bufferedAmount ?? 0,
    OPEN: 1,
    CLOSED: 3,
  }) as unknown as WsType & EventEmitter
  return ws
}

function makeMockLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

describe('registerStreamWs', () => {
  let ws: ReturnType<typeof makeMockWs>

  beforeEach(() => {
    ws = makeMockWs()
  })

  it('open 이벤트 발생 시 stream:register 메시지를 전송한다', async () => {
    const promise = registerStreamWs(ws, 'sess-1')
    ws.emit('open')
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'stream:registered' })))
    await promise
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'stream:register', sessionId: 'sess-1' }))
  })

  it('stream:registered 수신 후 resolve된다', async () => {
    const promise = registerStreamWs(ws, 'sess-abc')
    ws.emit('open')
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'stream:registered' })))
    await expect(promise).resolves.toBeUndefined()
  })

  it('stream:registered 이전의 무관한 메시지는 무시한다', async () => {
    const promise = registerStreamWs(ws, 'sess-2')
    ws.emit('open')
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'other:message', data: 'ignored' })))
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'still:ignored' })))
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'stream:registered' })))
    await expect(promise).resolves.toBeUndefined()
    expect(ws.send).toHaveBeenCalledTimes(1)
  })

  it('stream:registered 수신 후 message 리스너를 해제한다', async () => {
    const promise = registerStreamWs(ws, 'sess-3')
    ws.emit('open')
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'stream:registered' })))
    await promise
    // Listener removed — emitting again should not throw or affect anything
    expect(() => ws.emit('message', Buffer.from(JSON.stringify({ type: 'stream:registered' })))).not.toThrow()
    expect(ws.listenerCount('message')).toBe(0)
  })

  it('error 이벤트 발생 시 reject된다', async () => {
    const promise = registerStreamWs(ws, 'sess-err')
    const testError = new Error('connection refused')
    ws.emit('error', testError)
    await expect(promise).rejects.toThrow('connection refused')
  })

  it('open 전에 error가 발생해도 reject된다', async () => {
    const promise = registerStreamWs(ws, 'sess-err2')
    ws.emit('error', new Error('early error'))
    await expect(promise).rejects.toThrow('early error')
  })
})

describe('sendBinaryWithBackpressure', () => {
  const THRESHOLD = 1024
  const frame = Buffer.from('frame')

  it('정상 클라이언트: bufferedAmount < threshold → send 호출', () => {
    const ws = makeMockWs({ readyState: 1, bufferedAmount: 0 })
    const onDrop = vi.fn()
    const sent = sendBinaryWithBackpressure(ws, frame, THRESHOLD, onDrop)
    expect(ws.send).toHaveBeenCalledOnce()
    expect(onDrop).not.toHaveBeenCalled()
    expect(sent).toBe(true)
  })

  it('느린 클라이언트: bufferedAmount >= threshold → drop, send 없음', () => {
    const ws = makeMockWs({ readyState: 1, bufferedAmount: THRESHOLD })
    const onDrop = vi.fn()
    const sent = sendBinaryWithBackpressure(ws, frame, THRESHOLD, onDrop)
    expect(ws.send).not.toHaveBeenCalled()
    expect(onDrop).toHaveBeenCalledOnce()
    expect(sent).toBe(false)
  })

  it('임계치 바로 아래 (threshold - 1) → send 호출', () => {
    const ws = makeMockWs({ readyState: 1, bufferedAmount: THRESHOLD - 1 })
    const onDrop = vi.fn()
    sendBinaryWithBackpressure(ws, frame, THRESHOLD, onDrop)
    expect(ws.send).toHaveBeenCalledOnce()
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('닫힌 소켓(CLOSED): send도 drop도 호출하지 않는다', () => {
    const ws = makeMockWs({ readyState: 3, bufferedAmount: 0 })
    const onDrop = vi.fn()
    const sent = sendBinaryWithBackpressure(ws, frame, THRESHOLD, onDrop)
    expect(ws.send).not.toHaveBeenCalled()
    expect(onDrop).not.toHaveBeenCalled()
    expect(sent).toBe(false)
  })

  it('DEFAULT_BACKPRESSURE_BYTES는 1MB(1_048_576)이다', () => {
    expect(DEFAULT_BACKPRESSURE_BYTES).toBe(1_048_576)
  })
})

describe('createKeyframeAwareSender — drop-to-keyframe', () => {
  const THRESHOLD = 1024
  const frame = Buffer.from('frame')
  const KEY = true
  const DELTA = false

  it('정상(버퍼 여유)에선 keyframe·delta 모두 전송', () => {
    const ws = makeMockWs({ bufferedAmount: 0 })
    const s = createKeyframeAwareSender()
    const onDrop = vi.fn()
    expect(s.send(ws, frame, THRESHOLD, DELTA, onDrop)).toBe(true)
    expect(s.send(ws, frame, THRESHOLD, KEY, onDrop)).toBe(true)
    expect(ws.send).toHaveBeenCalledTimes(2)
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('버퍼 full이면 드롭하고 dropping 모드 진입', () => {
    const ws = makeMockWs({ bufferedAmount: THRESHOLD })
    const s = createKeyframeAwareSender()
    const onDrop = vi.fn()
    expect(s.send(ws, frame, THRESHOLD, DELTA, onDrop)).toBe(false)
    expect(ws.send).not.toHaveBeenCalled()
    expect(onDrop).toHaveBeenCalledOnce()
  })

  it('핵심: dropping 중엔 버퍼가 회복돼도 delta(P)는 계속 드롭', () => {
    const ws = makeMockWs({ bufferedAmount: THRESHOLD }) // full → 진입
    const s = createKeyframeAwareSender()
    const onDrop = vi.fn()
    s.send(ws, frame, THRESHOLD, DELTA, onDrop) // drop, enter dropping
    ws.bufferedAmount = 0                        // 버퍼 회복
    expect(s.send(ws, frame, THRESHOLD, DELTA, onDrop)).toBe(false) // 그래도 P는 드롭
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('keyframe(버퍼 여유)에서 재동기 → 이후 delta 정상 전송', () => {
    const ws = makeMockWs({ bufferedAmount: THRESHOLD })
    const s = createKeyframeAwareSender()
    const onDrop = vi.fn()
    s.send(ws, frame, THRESHOLD, DELTA, onDrop) // enter dropping
    ws.bufferedAmount = 0
    expect(s.send(ws, frame, THRESHOLD, KEY, onDrop)).toBe(true)   // keyframe서 재개
    expect(s.send(ws, frame, THRESHOLD, DELTA, onDrop)).toBe(true) // 이후 delta OK
    expect(ws.send).toHaveBeenCalledTimes(2)
  })

  it('dropping 중 keyframe이라도 버퍼 still full이면 드롭(재동기 안 함)', () => {
    const ws = makeMockWs({ bufferedAmount: THRESHOLD })
    const s = createKeyframeAwareSender()
    const onDrop = vi.fn()
    s.send(ws, frame, THRESHOLD, DELTA, onDrop) // enter dropping
    expect(s.send(ws, frame, THRESHOLD, KEY, onDrop)).toBe(false) // 여전히 full → 드롭
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('JPEG/독립 프레임(항상 keyframe)은 drop-to-latest와 동일', () => {
    const ws = makeMockWs({ bufferedAmount: THRESHOLD })
    const s = createKeyframeAwareSender()
    const onDrop = vi.fn()
    expect(s.send(ws, frame, THRESHOLD, KEY, onDrop)).toBe(false) // full → drop
    ws.bufferedAmount = 0
    expect(s.send(ws, frame, THRESHOLD, KEY, onDrop)).toBe(true)  // 회복 → 즉시 send
  })

  it('닫힌 소켓이면 send/drop 둘 다 없음', () => {
    const ws = makeMockWs({ readyState: 3, bufferedAmount: 0 })
    const s = createKeyframeAwareSender()
    const onDrop = vi.fn()
    expect(s.send(ws, frame, THRESHOLD, KEY, onDrop)).toBe(false)
    expect(ws.send).not.toHaveBeenCalled()
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('onWantKeyframe: dropping + 버퍼 회복 + delta → IDR 요청 발화', () => {
    const ws = makeMockWs({ bufferedAmount: THRESHOLD })
    const s = createKeyframeAwareSender()
    const onWant = vi.fn()
    s.send(ws, frame, THRESHOLD, DELTA, vi.fn(), onWant) // enter dropping (full)
    expect(onWant).not.toHaveBeenCalled()                // full → 아직 요청 안 함
    ws.bufferedAmount = 0
    s.send(ws, frame, THRESHOLD, DELTA, vi.fn(), onWant) // 회복했지만 키프레임 없음 → 요청
    expect(onWant).toHaveBeenCalledOnce()
  })

  it('onWantKeyframe: 정상(드롭 아님)일 땐 발화 안 함', () => {
    const ws = makeMockWs({ bufferedAmount: 0 })
    const s = createKeyframeAwareSender()
    const onWant = vi.fn()
    s.send(ws, frame, THRESHOLD, DELTA, vi.fn(), onWant)
    expect(onWant).not.toHaveBeenCalled()
  })
})

describe('sendAudioYieldingToVideo — audio yields to video on a shared socket', () => {
  const frame = Buffer.from('pcm')

  it('소켓이 비어 있으면(near-empty) 오디오를 전송', () => {
    const ws = makeMockWs({ bufferedAmount: 0 })
    const onDrop = vi.fn()
    expect(sendAudioYieldingToVideo(ws, frame, onDrop)).toBe(true)
    expect(ws.send).toHaveBeenCalledOnce()
    expect(ws.send).toHaveBeenCalledWith(frame, { binary: true })
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('핵심: 소켓 버퍼가 ceiling을 넘으면(=video가 버퍼 점유) 오디오를 드롭', () => {
    const ws = makeMockWs({ bufferedAmount: AUDIO_BUFFER_CEILING_BYTES + 1 })
    const onDrop = vi.fn()
    expect(sendAudioYieldingToVideo(ws, frame, onDrop)).toBe(false)
    expect(ws.send).not.toHaveBeenCalled()
    expect(onDrop).toHaveBeenCalledOnce()
  })

  it('ceiling 정확히까지는 전송(경계)', () => {
    const ws = makeMockWs({ bufferedAmount: AUDIO_BUFFER_CEILING_BYTES })
    expect(sendAudioYieldingToVideo(ws, frame, vi.fn())).toBe(true)
    expect(ws.send).toHaveBeenCalledOnce()
  })

  it('닫힌 소켓이면 send/drop 둘 다 없음', () => {
    const ws = makeMockWs({ readyState: 3, bufferedAmount: 0 })
    const onDrop = vi.fn()
    expect(sendAudioYieldingToVideo(ws, frame, onDrop)).toBe(false)
    expect(ws.send).not.toHaveBeenCalled()
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('무손상 보장: ceiling은 video 백프레셔 임계(1MB)보다 한참 낮다', () => {
    // Even with one audio frame on top, bufferedAmount stays ~ceiling+one frame — never the video threshold.
    expect(AUDIO_BUFFER_CEILING_BYTES).toBeLessThan(DEFAULT_BACKPRESSURE_BYTES / 4)
  })
})

// No-degradation gate (issue #259): audio and video share ONE socket (codec B). This pins the
// invariant that audio yields to video — it can never be the cause of a video drop.
describe('no-degradation invariant — audio never degrades video on a shared socket', () => {
  const VIDEO_THRESHOLD = DEFAULT_BACKPRESSURE_BYTES // 1 MB
  const frame = Buffer.from('x')
  const KEY = true
  const DELTA = false

  it('partial backpressure (above audio ceiling, below video threshold): audio drops, video sends', () => {
    // The socket has video bytes queued — not enough to backpressure video, but past the audio ceiling.
    const ws = makeMockWs({ bufferedAmount: AUDIO_BUFFER_CEILING_BYTES + 1 })
    const video = createKeyframeAwareSender()

    const audioSent = sendAudioYieldingToVideo(ws, frame, vi.fn())
    const videoSent = video.send(ws, frame, VIDEO_THRESHOLD, DELTA, vi.fn())

    expect(audioSent).toBe(false) // audio yields
    expect(videoSent).toBe(true)  // video unaffected
  })

  it('near-empty socket: both audio and video send (audio adds no harm when there is headroom)', () => {
    const ws = makeMockWs({ bufferedAmount: 0 })
    const video = createKeyframeAwareSender()
    expect(sendAudioYieldingToVideo(ws, frame, vi.fn())).toBe(true)
    expect(video.send(ws, frame, VIDEO_THRESHOLD, KEY, vi.fn())).toBe(true)
  })

  it('a sent audio frame cannot push the socket to the video backpressure point', () => {
    // Worst case: audio sends at exactly the ceiling. Even a large PCM chunk on top stays far below
    // the video threshold, so video never sees `full` because of audio.
    const ws = makeMockWs({ bufferedAmount: AUDIO_BUFFER_CEILING_BYTES })
    expect(sendAudioYieldingToVideo(ws, frame, vi.fn())).toBe(true)
    const largestPlausibleAudioChunk = 16_384 // 16 KB ≫ a 20-30ms S16 stereo PCM frame
    expect(AUDIO_BUFFER_CEILING_BYTES + largestPlausibleAudioChunk).toBeLessThan(VIDEO_THRESHOLD)
  })
})

describe('createRateLimitedDropWarn', () => {
  it('intervalMs 안에서는 warn을 1번만 호출한다', () => {
    vi.useFakeTimers()
    const logger = makeMockLogger()
    const onDrop = createRateLimitedDropWarn(logger, 'test-ctx', 1000)

    for (let i = 0; i < 100; i++) onDrop()

    expect(logger.warn).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('intervalMs 경과 후에는 다시 warn을 호출한다', () => {
    vi.useFakeTimers()
    const logger = makeMockLogger()
    const onDrop = createRateLimitedDropWarn(logger, 'test-ctx', 1000)

    onDrop()
    vi.advanceTimersByTime(1001)
    onDrop()

    expect(logger.warn).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('warn 메시지에 context가 포함된다', () => {
    vi.useFakeTimers()
    const logger = makeMockLogger()
    const onDrop = createRateLimitedDropWarn(logger, 'sess-xyz', 1000)
    onDrop()
    expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('sess-xyz')
    vi.useRealTimers()
  })
})
