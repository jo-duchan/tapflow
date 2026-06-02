// Web Worker hosting the tinyh264 (h264bsd) software H.264 decoder.
//
// Why a worker: software decode is CPU-bound; running it off the main thread keeps
// rendering / pointer / recording responsive. The decoder's WASM is inlined as a
// data-URI inside tinyh264, so there is no separate .wasm asset to serve.
//
// Message protocol (handled inside tinyh264's init()):
//   IN  { type:'decode',  renderStateId, data:ArrayBuffer, offset, length }      — one H.264 access unit (NALs)
//   IN  { type:'release', renderStateId }
//   OUT { type:'decoderReady' }                                                  — once, after WASM init
//   OUT { type:'pictureReady', renderStateId, width, height, data:ArrayBuffer }  — decoded YUV420 (transferable)
import { init } from 'tinyh264'

init()
