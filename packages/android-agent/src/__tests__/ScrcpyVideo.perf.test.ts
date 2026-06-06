import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import { ScrcpyVideo } from '../scrcpy/ScrcpyVideo'
import type { Socket } from 'net'

function makeHeader(name: string, width: number, height: number): Buffer {
  const header = Buffer.alloc(76)
  header.write(name, 0, 'utf8')
  header.write('h264', 64, 'utf8')
  header.writeUInt32BE(width, 68)
  header.writeUInt32BE(height, 72)
  return header
}

// N개의 frame-meta 패킷([12B 헤더][payload]) 스트림 생성. payload는 0x42로 채움.
function makePacketStream(count: number, payloadSize: number): Buffer {
  const parts: Buffer[] = []
  for (let i = 0; i < count; i++) {
    const header = Buffer.alloc(12) // pts_flags(8) + len(4), 플래그 없음 = P-frame
    header.writeUInt32BE(payloadSize, 8)
    parts.push(header, Buffer.alloc(payloadSize, 0x42))
  }
  return Buffer.concat(parts)
}

function fakeSocket(header: Buffer, dataChunks: Buffer[], emitEnd = true): Socket {
  const emitter = new EventEmitter()
  const socket = emitter as unknown as Socket
  process.nextTick(() => {
    emitter.emit('data', header)
    for (const chunk of dataChunks) emitter.emit('data', chunk)
    if (emitEnd) emitter.emit('end')
  })
  return socket
}

describe('ScrcpyVideo — 성능', () => {
  it('패킷 1000개를 200ms 이내에 파싱', async () => {
    const PACKET_COUNT = 1000
    const PAYLOAD_SIZE = 64

    const header = makeHeader('Pixel_8_Pro', 1080, 2400)
    const stream = makePacketStream(PACKET_COUNT, PAYLOAD_SIZE)
    const socket = fakeSocket(header, [stream])

    const video = new ScrcpyVideo(socket)
    await video.deviceInfo()

    const reader = video.start().getReader()
    const start = Date.now()
    let count = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      count++
      // 실제 payload 바이트가 포함되어 있는지 검증 (Potemkin 방지)
      expect(value.payload[0]).toBe(0x42)
    }
    const elapsed = Date.now() - start

    expect(count).toBe(PACKET_COUNT)
    // 200ms는 로컬 기준 여유 있는 임계값 — 실제 측정값은 통상 10ms 미만
    expect(elapsed).toBeLessThan(200)
  })

  it('패킷 1000개를 청크 단위(32바이트)로 분할 수신해도 손실 없음', async () => {
    const PACKET_COUNT = 1000
    const PAYLOAD_SIZE = 32
    const CHUNK_SIZE = 32

    const header = makeHeader('Pixel', 1080, 1920)
    const stream = makePacketStream(PACKET_COUNT, PAYLOAD_SIZE)

    // TCP 단편화 시뮬레이션: 32바이트 청크로 쪼갬
    const chunks: Buffer[] = []
    for (let i = 0; i < stream.length; i += CHUNK_SIZE) {
      chunks.push(stream.subarray(i, i + CHUNK_SIZE))
    }

    const socket = fakeSocket(header, chunks)
    const video = new ScrcpyVideo(socket)
    await video.deviceInfo()

    const reader = video.start().getReader()
    let count = 0
    while (true) {
      const { done } = await reader.read()
      if (done) break
      count++
    }

    expect(count).toBe(PACKET_COUNT)
  })
})
