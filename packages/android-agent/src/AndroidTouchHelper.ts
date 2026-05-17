import type { AdbWrapper } from './AdbWrapper.js'

const BUTTON_KEY_MAP: Record<string, string> = {
  home: 'KEYCODE_HOME',
  back: 'KEYCODE_BACK',
  recent_apps: 'KEYCODE_APP_SWITCH',
  power: 'KEYCODE_POWER',
  volume_up: 'KEYCODE_VOLUME_UP',
  volume_down: 'KEYCODE_VOLUME_DOWN',
}

export class AndroidTouchHelper {
  private screenSize: { width: number; height: number } | null = null
  private startX = 0
  private startY = 0
  private lastX = 0
  private lastY = 0
  private touching = false

  constructor(
    private readonly adb: AdbWrapper,
    private readonly serial: string,
  ) {}

  start(): void {}
  stop(): void {}

  private async getScreenSize(): Promise<{ width: number; height: number }> {
    if (!this.screenSize) {
      this.screenSize = await this.adb.getScreenSize(this.serial)
    }
    return this.screenSize
  }

  touchStart(x: number, y: number): void {
    this.touching = true
    this.startX = x; this.startY = y
    this.lastX = x;  this.lastY = y
  }

  touchMove(x: number, y: number): void {
    this.lastX = x; this.lastY = y
  }

  touchEnd(): void {
    if (!this.touching) return
    this.touching = false
    const isTap = Math.abs(this.lastX - this.startX) < 0.01 && Math.abs(this.lastY - this.startY) < 0.01
    void this.getScreenSize().then(({ width, height }) => {
      if (isTap) {
        const px = Math.round(this.startX * width)
        const py = Math.round(this.startY * height)
        this.adb.sendInput(this.serial, 'tap', String(px), String(py)).catch(() => {})
      } else {
        const x0 = Math.round(this.startX * width), y0 = Math.round(this.startY * height)
        const x1 = Math.round(this.lastX * width),  y1 = Math.round(this.lastY * height)
        this.adb.sendInput(this.serial, 'swipe', String(x0), String(y0), String(x1), String(y1), '300').catch(() => {})
      }
    })
  }

  pinchStart(_x1: number, _y1: number, _x2: number, _y2: number): void {}
  pinchMove(_x1: number, _y1: number, _x2: number, _y2: number): void {}
  pinchEnd(): void {}

  pressButton(name: string): void {
    const keyCode = BUTTON_KEY_MAP[name]
    if (!keyCode) { console.error(`[AndroidTouchHelper] Unknown button: ${name}`); return }
    this.adb.sendKeyEvent(this.serial, keyCode).catch(() => {})
  }
}
