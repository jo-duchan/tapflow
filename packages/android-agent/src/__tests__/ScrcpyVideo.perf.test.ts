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

// N개의 NAL 유닛을 포함하는 Annex B 스트림 생성
function makeAnnexBStream(nalCount: number, nalSize: number): Buffer {
  const startCode = Buffer.from([0x00, 0x00, 0x00, 0x01])
  const nalBody = Buffer.alloc(nalSize, 0x42) // 임의 NAL 바이트
  const parts: Buffer[] = []
  for (let i = 0; i < nalCount; i++) {
    parts.push(startCode, nalBody)
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
  it('NAL 유닛 1000개를 200ms 이내에 파싱', async () => {
    const NAL_COUNT = 1000
    const NAL_SIZE = 64

    const header = makeHeader('Pixel_8_Pro', 1080, 2400)
    const stream = makeAnnexBStream(NAL_COUNT, NAL_SIZE)
    const socket = fakeSocket(header, [stream])

    const video = new ScrcpyVideo(socket)
    await video.deviceInfo()

    const readableStream = video.start()
    const reader = readableStream.getReader()

    const start = Date.now()
    let count = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      count++
      // 실제 NAL 바이트가 포함되어 있는지 검증 (Potemkin 방지)
      expect(value[4]).toBe(0x42)
    }
    const elapsed = Date.now() - start

    expect(count).toBe(NAL_COUNT)
    // 200ms는 로컬 기준 여유 있는 임계값 — 실제 측정값은 통상 10ms 미만
    expect(elapsed).toBeLessThan(200)
  })

  it('NAL 유닛 1000개를 청크 단위(32바이트)로 분할 수신해도 손실 없음', async () => {
    const NAL_COUNT = 1000
    const NAL_SIZE = 32
    const CHUNK_SIZE = 32

    const header = makeHeader('Pixel', 1080, 1920)
    const stream = makeAnnexBStream(NAL_COUNT, NAL_SIZE)

    // TCP 단편화 시뮬레이션: 32바이트 청크로 쪼갬
    const chunks: Buffer[] = []
    for (let i = 0; i < stream.length; i += CHUNK_SIZE) {
      chunks.push(stream.subarray(i, i + CHUNK_SIZE))
    }

    const socket = fakeSocket(header, chunks)
    const video = new ScrcpyVideo(socket)
    await video.deviceInfo()

    const readableStream = video.start()
    const reader = readableStream.getReader()
    let count = 0
    while (true) {
      const { done } = await reader.read()
      if (done) break
      count++
    }

    expect(count).toBe(NAL_COUNT)
  })
})
