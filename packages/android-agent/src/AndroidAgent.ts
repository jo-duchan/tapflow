import os from 'os'
import { WebSocket } from 'ws'
import type { AndroidButton, Device, DeviceAgent } from '@tapflow/agent-core'
import { AdbWrapper } from './AdbWrapper.js'
import { EmulatorLauncher } from './EmulatorLauncher.js'
import { AndroidTouchHelper } from './AndroidTouchHelper.js'
import { ScrcpySession } from './scrcpy/ScrcpySession.js'

const ANDROID_BUTTONS: AndroidButton[] = [
  { name: 'home',        accessibilityTitle: 'Home',        keyCode: 3 },
  { name: 'back',        accessibilityTitle: 'Back',        keyCode: 4 },
  { name: 'recent_apps', accessibilityTitle: 'Recent Apps', keyCode: 187 },
  { name: 'volume_up',   accessibilityTitle: 'Volume Up',   keyCode: 24 },
  { name: 'volume_down', accessibilityTitle: 'Volume Down', keyCode: 25 },
  { name: 'power',       accessibilityTitle: 'Power',       keyCode: 26 },
]

interface DeviceState {
  sessionId: string
  deviceId: string
  touchHelper: AndroidTouchHelper | null
  streamWs: WebSocket | null
  scrcpySession: ScrcpySession | null
  displayWidth: number
  displayHeight: number
  lastTouchPx: { x: number; y: number }
  bootSeq: number
  orientation: 'portrait' | 'landscape'
}

export interface AndroidAgentOptions {
  fps?: number
}

export class AndroidAgent implements DeviceAgent {
  private readonly adb: AdbWrapper
  private readonly launcher: EmulatorLauncher
  private ws: WebSocket | null = null
  private deviceStates = new Map<string, DeviceState>()
  private relayUrl: string | null = null

  constructor(_options: AndroidAgentOptions = {}, adb?: AdbWrapper) {
    this.adb = adb ?? new AdbWrapper()
    this.launcher = new EmulatorLauncher()
  }

  get sessionId(): string | null {
    const first = this.deviceStates.values().next().value
    return first?.sessionId ?? null
  }

  async connect(relayUrl: string): Promise<void> {
    this.relayUrl = relayUrl
    const devices = await this.adb.listDevices()

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relayUrl)

      ws.once('open', () => {
        ws.send(JSON.stringify({
          type: 'agent:register',
          platform: 'android',
          agentName: os.hostname(),
          devices: devices.map((d) => ({
            id: d.id,
            name: d.name,
            platform: d.platform,
            status: d.status,
            osVersion: d.osVersion,
          })),
        }))
      })

      ws.once('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'agent:registered') {
          this.ws = ws
          this.initDeviceStates(
            msg.registeredSessions as Array<{ deviceId: string; sessionId: string }>,
          )
          ws.on('message', (d) => {
            try { this.handleRelayMessage(JSON.parse(d.toString())) } catch { /* ignore malformed */ }
          })
          resolve()
        } else {
          reject(new Error(`Unexpected message during handshake: ${msg.type}`))
        }
      })

      ws.once('error', reject)
    })
  }

  private initDeviceStates(
    registeredSessions: Array<{ deviceId: string; sessionId: string }>,
  ): void {
    registeredSessions.forEach(({ deviceId, sessionId }) => {
      this.deviceStates.set(sessionId, {
        sessionId,
        deviceId,
        touchHelper: null,
        streamWs: null,
        scrcpySession: null,
        displayWidth: 0,
        displayHeight: 0,
        lastTouchPx: { x: 0, y: 0 },
        bootSeq: 0,
        orientation: 'portrait',
      })
    })
  }

  disconnect(): void {
    for (const state of this.deviceStates.values()) {
      this.cleanupDeviceState(state)
    }
    this.deviceStates.clear()
    this.ws?.close()
    this.ws = null
    this.relayUrl = null
  }

  private cleanupDeviceState(state: DeviceState): void {
    const serial = this.adb.getSerial(state.deviceId)
    if (serial && state.scrcpySession) state.scrcpySession.stop(serial)
    state.scrcpySession = null
    state.touchHelper?.stop()
    state.touchHelper = null
    state.streamWs?.close()
    state.streamWs = null
  }

  private sendDeviceInfo(state: DeviceState, device: Device): void {
    if (!this.ws) return
    this.ws.send(JSON.stringify({
      type: 'session:deviceInfo',
      sessionId: state.sessionId,
      payload: {
        deviceName: device.name,
        osVersion: device.osVersion ?? '',
      },
    }))

    this.ws.send(JSON.stringify({
      type: 'session:chrome',
      sessionId: state.sessionId,
      payload: { buttons: ANDROID_BUTTONS, streamType: 'h264' },
    }))
  }

  private async startVideoStream(state: DeviceState, streamWs: WebSocket): Promise<void> {
    const serial = this.adb.getSerial(state.deviceId)
    if (!serial) return

    const touchHelper = new AndroidTouchHelper(this.adb, serial)
    touchHelper.start()
    state.touchHelper = touchHelper

    const session = new ScrcpySession()
    const info = await session.start(serial)
    state.scrcpySession = session
    state.displayWidth = info.width
    state.displayHeight = info.height

    const stream = session.video.start()
    const reader = stream.getReader()
    const startedAt = Date.now()

    const pump = async () => {
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (streamWs.readyState === WebSocket.OPEN) streamWs.send(value)
        }
      } catch {
        // stream cancelled or ws closed — expected on disconnect
      }
      const ranMs = Date.now() - startedAt
      // Never silently restart — creates zombie scrcpy server processes.
      // Report to relay so the dashboard can trigger device:boot again if needed.
      if (state.scrcpySession === session) {
        console.error(`[android-agent] scrcpy stream ended after ${ranMs}ms`)
        this.ws?.send(JSON.stringify({
          type: 'device:boot-error',
          sessionId: state.sessionId,
          message: `scrcpy stream ended after ${Math.round(ranMs / 1000)}s`,
        }))
      }
    }

    pump()
  }

  private async openStreamWs(state: DeviceState): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const streamWs = new WebSocket(this.relayUrl!)
      state.streamWs = streamWs

      streamWs.once('open', () => {
        streamWs.send(JSON.stringify({ type: 'stream:register', sessionId: state.sessionId }))
      })

      const onMsg = (data: Buffer) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'stream:registered') {
          streamWs.off('message', onMsg)
          resolve(streamWs)
        }
      }
      streamWs.on('message', onMsg)
      streamWs.once('error', reject)
    })
  }

  private async handleDeviceBoot(sessionId: string, avdId: string): Promise<void> {
    const state = this.deviceStates.get(sessionId)
    if (!state || !this.ws) return

    const seq = ++state.bootSeq

    this.cleanupDeviceState(state)
    this.ws.send(JSON.stringify({ type: 'device:booting', sessionId }))

    try {
      const avdName = avdId.replace(/^avd:/, '')
      const devices = await this.adb.listDevices()
      if (seq !== state.bootSeq) return

      const target = devices.find((d) => d.id === avdId)
      if (!target) throw new Error(`Device not found: ${avdId}`)

      if (target.status !== 'booted') {
        this.launcher.launch(avdName)
        const serial = await this.launcher.findSerial(avdName)
        if (seq !== state.bootSeq) return
        await this.launcher.waitForBoot(serial)
        if (seq !== state.bootSeq) return
        this.adb.setSerial(avdId, serial)
      }

      const refreshed = await this.adb.listDevices()
      if (seq !== state.bootSeq) return
      const refreshedDevice = refreshed.find((d) => d.id === avdId) ?? target

      this.sendDeviceInfo(state, { ...refreshedDevice, status: 'booted' } as Device)

      const streamWs = await this.openStreamWs(state)
      if (seq !== state.bootSeq) {
        streamWs.close()
        return
      }

      await this.startVideoStream(state, streamWs)
      if (seq !== state.bootSeq) return
      this.ws?.send(JSON.stringify({ type: 'device:ready', sessionId, payload: { deviceId: avdId } }))
    } catch (e) {
      if (seq !== state.bootSeq) return
      const message = e instanceof Error ? e.message : String(e)
      console.error('[android-agent] boot failed:', message)
      this.ws?.send(JSON.stringify({ type: 'device:boot-error', sessionId, message }))
    }
  }

  private async handleDeviceShutdown(sessionId: string, avdId: string): Promise<void> {
    const state = this.deviceStates.get(sessionId)
    if (!state) return

    state.bootSeq++
    this.cleanupDeviceState(state)

    const serial = this.adb.getSerial(avdId)
    if (serial) {
      // best-effort — emulator may already be gone
      await this.adb.shutdown(serial).catch((e: unknown) => {
        console.warn('[android-agent] emu kill failed (already gone?):', (e as Error).message)
      })
      this.adb.clearSerial(avdId)
    }
    this.ws?.send(JSON.stringify({
      type: 'device:shutdown-done',
      sessionId,
      payload: { deviceId: avdId },
    }))
  }

  private handleRelayMessage(msg: { type: string; sessionId?: string; payload?: unknown }): void {
    switch (msg.type) {
      case 'device:boot': {
        const { deviceId } = msg.payload as { deviceId: string }
        this.handleDeviceBoot(msg.sessionId!, deviceId)
          .catch((e) => console.error('[android-agent] handleDeviceBoot failed:', e))
        break
      }
      case 'device:shutdown': {
        const { deviceId } = msg.payload as { deviceId: string }
        this.handleDeviceShutdown(msg.sessionId!, deviceId)
          .catch((e) => console.error('[android-agent] handleDeviceShutdown failed:', e))
        break
      }
      case 'app:install': {
        const { filePath, bundleId } = msg.payload as { filePath: string; bundleId?: string }
        const sessionId = msg.sessionId
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!serial) {
          this.ws?.send(JSON.stringify({ type: 'app:install-error', sessionId, message: 'No booted device' }))
          break
        }
        if (filePath.endsWith('.app.zip') || filePath.endsWith('.app')) {
          this.ws?.send(JSON.stringify({
            type: 'app:install-error',
            sessionId,
            message: '.app.zip is an iOS simulator build — upload a .apk file for Android.',
          }))
          break
        }
        void bundleId
        this.adb.installApp(serial, filePath)
          .then(() => this.ws?.send(JSON.stringify({ type: 'app:install-done', sessionId })))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            this.ws?.send(JSON.stringify({ type: 'app:install-error', sessionId, message }))
          })
        break
      }
      case 'app:launch': {
        const { bundleId } = msg.payload as { bundleId: string }
        const sessionId = msg.sessionId
        const state = this.deviceStates.get(sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!serial) {
          this.ws?.send(JSON.stringify({ type: 'app:launch-error', sessionId, message: 'No booted device' }))
          break
        }
        this.adb.launchApp(serial, bundleId)
          .then(() => this.ws?.send(JSON.stringify({ type: 'app:launch-done', sessionId })))
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            this.ws?.send(JSON.stringify({ type: 'app:launch-error', sessionId, message }))
          })
        break
      }
      case 'input:touch:start': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state) break
        const { x, y } = msg.payload as { x: number; y: number }
        if (state.scrcpySession && state.displayWidth > 0) {
          const px = Math.round(x * state.displayWidth)
          const py = Math.round(y * state.displayHeight)
          state.lastTouchPx = { x: px, y: py }
          state.scrcpySession.control.touchDown(0, px, py)
        } else {
          state.touchHelper?.touchStart(x, y)
        }
        break
      }
      case 'input:touch:move': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state) break
        const { x, y } = msg.payload as { x: number; y: number }
        if (state.scrcpySession && state.displayWidth > 0) {
          const px = Math.round(x * state.displayWidth)
          const py = Math.round(y * state.displayHeight)
          state.lastTouchPx = { x: px, y: py }
          state.scrcpySession.control.touchMove(0, px, py)
        } else {
          state.touchHelper?.touchMove(x, y)
        }
        break
      }
      case 'input:touch:end': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state) break
        if (state.scrcpySession) {
          state.scrcpySession.control.touchUp(0, state.lastTouchPx.x, state.lastTouchPx.y)
        } else {
          state.touchHelper?.touchEnd()
        }
        break
      }
      case 'input:pinch:start': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state?.touchHelper) break
        const { x1, y1, x2, y2 } = msg.payload as { x1: number; y1: number; x2: number; y2: number }
        state.touchHelper.pinchStart(x1, y1, x2, y2)
        break
      }
      case 'input:pinch:move': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state?.touchHelper) break
        const { x1, y1, x2, y2 } = msg.payload as { x1: number; y1: number; x2: number; y2: number }
        state.touchHelper.pinchMove(x1, y1, x2, y2)
        break
      }
      case 'input:pinch:end': {
        const state = this.deviceStates.get(msg.sessionId!)
        state?.touchHelper?.pinchEnd()
        break
      }
      case 'input:rotate': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state) break
        state.orientation = state.orientation === 'portrait' ? 'landscape' : 'portrait'
        const serial = this.adb.getSerial(state.deviceId)
        if (serial) {
          this.adb.setRotation(serial, state.orientation === 'landscape')
            .catch((e) => console.error('[android-agent] rotate failed:', e))
        }
        break
      }
      case 'input:button': {
        const state = this.deviceStates.get(msg.sessionId!)
        if (!state?.touchHelper) break
        const { name } = msg.payload as { name: string }
        state.touchHelper.pressButton(name)
        break
      }
      case 'input:keyboard:toggle': {
        const state = this.deviceStates.get(msg.sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (serial) this.adb.sendKeyEvent(serial, '82').catch(() => {}) // KEYCODE_MENU
        break
      }
      case 'input:key': {
        const state = this.deviceStates.get(msg.sessionId!)
        const serial = state ? this.adb.getSerial(state.deviceId) : undefined
        if (!serial) break
        const { code, modifiers } = msg.payload as { code: string; modifiers: number }
        this.handleKeyInput(serial, code, modifiers).catch(() => {})
        break
      }
    }
  }

  private async handleKeyInput(serial: string, code: string, modifiers: number): Promise<void> {
    const SPECIAL: Record<string, string> = {
      Backspace: '67', Enter: '66', Tab: '61', Space: '62', Escape: '111',
      ArrowLeft: '21', ArrowRight: '22', ArrowUp: '19', ArrowDown: '20',
      Delete: '112', Home: '122', End: '123', PageUp: '92', PageDown: '93',
      F1: '131', F2: '132', F3: '133', F4: '134', F5: '135',
      F6: '136', F7: '137', F8: '138', F9: '139', F10: '140', F11: '141', F12: '142',
    }
    if (SPECIAL[code]) {
      await this.adb.sendKeyEvent(serial, SPECIAL[code])
      return
    }
    const shift = Boolean(modifiers & 0x02)
    let char: string | null = null
    if (code.startsWith('Key')) {
      const letter = code.slice(3)
      char = shift ? letter.toUpperCase() : letter.toLowerCase()
    } else if (code.startsWith('Digit')) {
      const digit = code.slice(5)
      const shiftDigits: Record<string, string> = {
        '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
        '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
      }
      char = shift ? (shiftDigits[digit] ?? digit) : digit
    } else {
      const PUNCT: Record<string, [string, string]> = {
        Minus: ['-', '_'], Equal: ['=', '+'],
        BracketLeft: ['[', '{'], BracketRight: [']', '}'],
        Backslash: ['\\', '|'], Semicolon: [';', ':'],
        Quote: ["'", '"'], Comma: [',', '<'],
        Period: ['.', '>'], Slash: ['/', '?'], Backquote: ['`', '~'],
      }
      if (PUNCT[code]) char = shift ? PUNCT[code][1] : PUNCT[code][0]
    }
    if (char) await this.adb.sendInput(serial, 'text', char)
  }

  listDevices(): Promise<Device[]> { return this.adb.listDevices() }

  async boot(avdId: string): Promise<void> {
    const avdName = avdId.replace(/^avd:/, '')
    this.launcher.launch(avdName)
    const serial = await this.launcher.findSerial(avdName)
    await this.launcher.waitForBoot(serial)
    this.adb.setSerial(avdId, serial)
  }

  async shutdown(avdId: string): Promise<void> {
    const serial = this.adb.getSerial(avdId)
    if (serial) {
      await this.adb.shutdown(serial)
      this.adb.clearSerial(avdId)
    }
  }

  async installApp(apkPath: string): Promise<void> {
    const first = this.deviceStates.values().next().value
    const serial = first ? this.adb.getSerial(first.deviceId) : undefined
    if (!serial) throw new Error('no booted device — call connect() first')
    await this.adb.installApp(serial, apkPath)
  }

  async launchApp(packageName: string): Promise<void> {
    const first = this.deviceStates.values().next().value
    const serial = first ? this.adb.getSerial(first.deviceId) : undefined
    if (!serial) throw new Error('no booted device — call connect() first')
    await this.adb.launchApp(serial, packageName)
  }

  async screenshot(): Promise<Buffer> {
    const first = this.deviceStates.values().next().value
    const serial = first ? this.adb.getSerial(first.deviceId) : undefined
    if (!serial) throw new Error('no booted device — call connect() first')
    return this.adb.screenshot(serial)
  }

  stream(): ReadableStream<Buffer> {
    const state = this.deviceStates.values().next().value
    if (!state?.scrcpySession) throw new Error('no active scrcpy session — call connect() first')
    return state.scrcpySession.video.start()
  }

  touchStart(x: number, y: number): void {
    const first = this.deviceStates.values().next().value
    first?.touchHelper?.touchStart(x, y)
  }

  touchMove(x: number, y: number): Promise<void> {
    const first = this.deviceStates.values().next().value
    first?.touchHelper?.touchMove(x, y)
    return Promise.resolve()
  }

  touchEnd(): Promise<void> {
    const first = this.deviceStates.values().next().value
    first?.touchHelper?.touchEnd()
    return Promise.resolve()
  }

  type(_text: string): Promise<void> { return Promise.resolve() }
  pressKey(_key: string): Promise<void> { return Promise.resolve() }
}
