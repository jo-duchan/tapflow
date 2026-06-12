import '@testing-library/jest-dom'

// Radix UI(Select 등)가 쓰는 포인터/스크롤 API — jsdom에 없어서 폴리필
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
