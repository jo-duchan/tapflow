// Transitional re-export. AndroidViewer still drives its own WebGL canvas via the
// onFrame-based decode core (WebCodecsCore). It switches to pickDecoder() +
// decoder-owned surface in a later step, after which this shim is removed.
export { WebCodecsCore as H264Decoder } from './decoders/WebCodecsCore'
