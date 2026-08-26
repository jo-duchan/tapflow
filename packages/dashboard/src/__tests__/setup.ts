import '@testing-library/jest-dom'

// Radix UI(Select 등)가 쓰는 포인터/스크롤 API — jsdom에 없어서 폴리필
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}

// jsdom has no ResizeObserver — QASession's viewer-width measurement needs one to mount. No-op is
// enough for tests that don't care about actual resize behaviour; those stub their own via
// vi.stubGlobal. Implements the real lib.dom `ResizeObserver` interface, so no cast is needed.
class ResizeObserverStub implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub
