// tinyh264 ships no type definitions (package.json has no "types").
// Minimal ambient declaration for the worker entry we use. init() instantiates
// the embedded WASM (inlined as a data-URI — no separate .wasm asset) and wires
// the worker message protocol; see tinyh264.worker.ts for the message shapes.
declare module 'tinyh264' {
  export function init(): Promise<void>
}
