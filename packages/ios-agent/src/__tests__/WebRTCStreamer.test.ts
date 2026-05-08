import { describe, it, expect, vi, beforeEach } from 'vitest'
import sharp from 'sharp'

vi.mock('@roamhq/wrtc', () => {
  const onFrameMock = vi.fn()
  const createTrackMock = vi.fn(() => ({}))
  const RTCVideoSourceMock = vi.fn(() => ({ onFrame: onFrameMock, createTrack: createTrackMock }))

  const addTrackMock = vi.fn()
  let iceCb: ((e: { candidate: RTCIceCandidate | null }) => void) | null = null
  const createOfferMock = vi.fn(async () => ({ type: 'offer', sdp: 'mock-sdp' }))
  const setLocalDescriptionMock = vi.fn()
  const setRemoteDescriptionMock = vi.fn()
  const addIceCandidateMock = vi.fn()
  const closeMock = vi.fn()

  const RTCPeerConnectionMock = vi.fn(() => ({
    addTrack: addTrackMock,
    set onicecandidate(cb: (e: { candidate: RTCIceCandidate | null }) => void) { iceCb = cb },
    createOffer: createOfferMock,
    setLocalDescription: setLocalDescriptionMock,
    setRemoteDescription: setRemoteDescriptionMock,
    addIceCandidate: addIceCandidateMock,
    close: closeMock,
    triggerIce: (c: RTCIceCandidate) => iceCb?.({ candidate: c }),
  }))

  const RTCSessionDescriptionMock = vi.fn((init: RTCSessionDescriptionInit) => init)

  return {
    RTCPeerConnection: RTCPeerConnectionMock,
    RTCSessionDescription: RTCSessionDescriptionMock,
    nonstandard: {
      RTCVideoSource: RTCVideoSourceMock,
      rgbaToI420: vi.fn(),
    },
  }
})

import { WebRTCStreamer } from '../WebRTCStreamer'

const makeJpeg = () =>
  sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
    .jpeg()
    .toBuffer()

describe('WebRTCStreamer', () => {
  let onOffer: ReturnType<typeof vi.fn>
  let onIceCandidate: ReturnType<typeof vi.fn>
  let streamer: WebRTCStreamer

  beforeEach(async () => {
    const { RTCPeerConnection, RTCSessionDescription, nonstandard } = await import('@roamhq/wrtc')
    vi.mocked(RTCPeerConnection).mockClear()
    vi.mocked(RTCSessionDescription).mockClear()
    vi.mocked(nonstandard.RTCVideoSource).mockClear()
    vi.mocked(nonstandard.rgbaToI420).mockClear()

    onOffer = vi.fn()
    onIceCandidate = vi.fn()
    streamer = new WebRTCStreamer({ onOffer, onIceCandidate })
  })

  it('calls onOffer with offer SDP on start()', async () => {
    await streamer.start()
    expect(onOffer).toHaveBeenCalledWith({ type: 'offer', sdp: 'mock-sdp' })
  })

  it('calls setRemoteDescription on setAnswer()', async () => {
    const { RTCPeerConnection } = await import('@roamhq/wrtc')
    await streamer.setAnswer({ type: 'answer', sdp: 'answer-sdp' })
    const pc = vi.mocked(RTCPeerConnection).mock.results[0].value
    expect(pc.setRemoteDescription).toHaveBeenCalled()
  })

  it('pushFrame decodes JPEG and calls videoSource.onFrame with I420', async () => {
    const { nonstandard } = await import('@roamhq/wrtc')
    const jpeg = await makeJpeg()
    await streamer.pushFrame(jpeg)
    const source = vi.mocked(nonstandard.RTCVideoSource).mock.results[0].value
    expect(nonstandard.rgbaToI420).toHaveBeenCalled()
    expect(source.onFrame).toHaveBeenCalledWith(
      expect.objectContaining({ width: 4, height: 4 }),
    )
  })

  it('close() calls pc.close()', async () => {
    const { RTCPeerConnection } = await import('@roamhq/wrtc')
    streamer.close()
    const pc = vi.mocked(RTCPeerConnection).mock.results[0].value
    expect(pc.close).toHaveBeenCalled()
  })
})
