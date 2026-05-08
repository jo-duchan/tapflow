declare module '@roamhq/wrtc' {
  export class RTCPeerConnection {
    onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null
    addTrack(track: MediaStreamTrack): RTCRtpSender
    createOffer(): Promise<RTCSessionDescriptionInit>
    setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>
    setRemoteDescription(description: RTCSessionDescription): Promise<void>
    addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>
    close(): void
  }

  export class RTCSessionDescription {
    constructor(init: { type: RTCSdpType; sdp: string })
  }

  export const nonstandard: {
    RTCVideoSource: new () => {
      createTrack(): MediaStreamTrack
      onFrame(frame: { width: number; height: number; data: Buffer }): void
    }
    rgbaToI420(
      rgba: { width: number; height: number; data: Buffer },
      i420: { width: number; height: number; data: Buffer },
    ): void
  }
}
