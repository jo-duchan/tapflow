'use client'

import { useCallback, useEffect, useRef } from 'react'

interface UseWebRTCOptions {
  onTrack(stream: MediaStream): void
  send(msg: object): void
  sessionId: string
}

export function useWebRTC({ onTrack, send, sessionId }: UseWebRTCOptions) {
  const pc = useRef<RTCPeerConnection | null>(null)

  const handleOffer = useCallback(
    async (offer: RTCSessionDescriptionInit) => {
      const peerConnection = new RTCPeerConnection()
      pc.current = peerConnection

      peerConnection.ontrack = (e) => {
        if (e.streams[0]) onTrack(e.streams[0])
      }

      peerConnection.onicecandidate = ({ candidate }) => {
        if (candidate) {
          send({ type: 'webrtc:ice', payload: candidate.toJSON() })
        }
      }

      await peerConnection.setRemoteDescription(offer)
      const answer = await peerConnection.createAnswer()
      await peerConnection.setLocalDescription(answer)

      send({ type: 'webrtc:answer', sessionId, payload: { type: answer.type, sdp: answer.sdp } })
    },
    [onTrack, send, sessionId],
  )

  const addIceCandidate = useCallback(async (candidate: RTCIceCandidateInit) => {
    await pc.current?.addIceCandidate(candidate)
  }, [])

  useEffect(() => {
    return () => {
      pc.current?.close()
      pc.current = null
    }
  }, [])

  return { handleOffer, addIceCandidate }
}
