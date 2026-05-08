import { RTCPeerConnection, RTCSessionDescription, nonstandard } from '@roamhq/wrtc'
import sharp from 'sharp'

const { RTCVideoSource, rgbaToI420 } = nonstandard

export type IceCandidate = RTCIceCandidateInit
export type SessionDescription = { type: 'offer' | 'answer'; sdp: string }

export interface WebRTCStreamerCallbacks {
  onOffer(offer: SessionDescription): void
  onIceCandidate(candidate: IceCandidate): void
}

export class WebRTCStreamer {
  private pc: RTCPeerConnection
  private videoSource: InstanceType<typeof RTCVideoSource>
  private frameWidth = 0
  private frameHeight = 0

  constructor(private readonly callbacks: WebRTCStreamerCallbacks) {
    this.videoSource = new RTCVideoSource()
    this.pc = new RTCPeerConnection()

    const track = this.videoSource.createTrack()
    this.pc.addTrack(track)

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.callbacks.onIceCandidate(candidate.toJSON())
    }
  }

  async start(): Promise<void> {
    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    this.callbacks.onOffer({ type: 'offer', sdp: offer.sdp! })
  }

  async setAnswer(answer: SessionDescription): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer))
  }

  async addIceCandidate(candidate: IceCandidate): Promise<void> {
    await this.pc.addIceCandidate(candidate)
  }

  async pushFrame(jpegBuffer: Buffer): Promise<void> {
    const { data, info } = await sharp(jpegBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })

    const { width, height } = info
    this.frameWidth = width
    this.frameHeight = height

    const i420 = Buffer.alloc(Math.floor(width * height * 1.5))
    rgbaToI420({ width, height, data }, { width, height, data: i420 })

    this.videoSource.onFrame({ width, height, data: i420 })
  }

  close(): void {
    this.pc.close()
  }
}
