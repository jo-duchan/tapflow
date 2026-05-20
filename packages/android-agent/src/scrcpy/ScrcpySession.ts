import net from 'net'
import path from 'path'
import { fileURLToPath } from 'url'
import { execFile, spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import { promisify } from 'util'
import { ScrcpyVideo } from './ScrcpyVideo.js'
import { ScrcpyControl } from './ScrcpyControl.js'
import type { ScrcpyDeviceInfo } from './ScrcpyVideo.js'
import { createLogger } from '@tapflowio/agent-core'

const logger = createLogger('android-agent:scrcpy')

const execFileAsync = promisify(execFile)

const SCRCPY_SERVER_VERSION = '3.1'
const DEVICE_PATH = '/data/local/tmp/scrcpy-server.jar'

function getAdbPath(): string {
  if (process.env['ADB_PATH']) return process.env['ADB_PATH']
  const androidHome = process.env['ANDROID_HOME']
  if (!androidHome) throw new Error('ANDROID_HOME not set')
  return `${androidHome}/platform-tools/adb`
}

function getServerJarPath(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  // src/scrcpy/ → ../../bin/  (or dist/scrcpy/ → ../../bin/)
  return path.resolve(dir, '../../bin/scrcpy-server.jar')
}

// Each session gets its own port; control connects to the same forwarded port
let nextPort = 27183
function allocatePort(): number {
  return nextPort++
}

export class ScrcpySession {
  private readonly scid: string
  private readonly socketName: string
  private serverProc: ChildProcess | null = null
  private videoSocket: net.Socket | null = null
  private controlSocket: net.Socket | null = null
  private _video: ScrcpyVideo | null = null
  private _control: ScrcpyControl | null = null
  private port = 0

  constructor() {
    const buf = randomBytes(4)
    buf[0]! &= 0x7f  // Java Integer.parseInt rejects values > 0x7FFFFFFF
    this.scid = buf.toString('hex')
    this.socketName = `scrcpy_${this.scid}`
  }

  get video(): ScrcpyVideo {
    if (!this._video) throw new Error('ScrcpySession not started')
    return this._video
  }

  get control(): ScrcpyControl {
    if (!this._control) throw new Error('ScrcpySession not started')
    return this._control
  }

  async start(serial: string, onRotation?: (rotation: number) => void): Promise<ScrcpyDeviceInfo> {
    const adb = getAdbPath()
    const port = allocatePort()
    this.port = port
    const jarPath = getServerJarPath()

    await execFileAsync(adb, ['-s', serial, 'push', jarPath, DEVICE_PATH])

    const serverProc = spawn(adb, [
      '-s', serial, 'shell',
      `CLASSPATH=${DEVICE_PATH} app_process / com.genymobile.scrcpy.Server`,
      SCRCPY_SERVER_VERSION,
      `scid=${this.scid}`,
      'tunnel_forward=true',
      'video_codec=h264',
      'video_encoder=OMX.google.h264.encoder', // software encoder — avoids c2.android.avc.encoder stalling under GPU load
      'video_bit_rate=8000000',
      'max_fps=30',
      'audio=false',
      'stay_awake=true',         // prevent device display from sleeping during capture
      'send_device_meta=true',   // 64-byte name + codec-id + width + height header
      'send_frame_meta=false',   // raw Annex B stream (no length prefix per frame)
      'send_dummy_byte=false',   // skip the 1-byte connection-check byte
      'video_codec_options=i-frame-interval:int=1', // 1s IDR interval for faster keyframe recovery after restart
    ], { stdio: ['ignore', 'pipe', 'ignore'] })

    this.serverProc = serverProc
    // adb shell mixes server stdout+stderr into the local process stdout
    serverProc.stdout?.on('data', (d: Buffer) => {
      const msg = d.toString().trim()
      if (msg) logger.debug(msg)
    })
    serverProc.unref()

    try {
      // Wait for server to bind the abstract socket
      await new Promise((r) => setTimeout(r, 1500))

      await execFileAsync(adb, ['-s', serial, 'forward', `tcp:${port}`, `localabstract:${this.socketName}`])

      // scrcpy accepts connections sequentially on the same socket:
      // 1st accept() → video stream, 2nd accept() → control stream
      this.videoSocket = await this.connectTcp(port)
      this.controlSocket = await this.connectTcp(port)

      this._video = new ScrcpyVideo(this.videoSocket)
      const info = await this._video.deviceInfo()

      this._control = new ScrcpyControl(this.controlSocket, info.width, info.height, onRotation)
      logger.info(`ready — ${info.deviceName} ${info.width}×${info.height}`)
      return info
    } catch (e) {
      serverProc.kill()
      this.serverProc = null
      throw e
    }
  }

  stop(serial: string): void {
    this.serverProc?.kill()
    this.serverProc = null
    this.videoSocket?.destroy()
    this.controlSocket?.destroy()
    this.videoSocket = null
    this.controlSocket = null
    this._video = null
    this._control = null

    const adb = getAdbPath()
    execFile(adb, ['-s', serial, 'forward', '--remove', `tcp:${this.port}`], () => {})
  }

  private connectTcp(port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket: net.Socket = net.connect(port, '127.0.0.1', () => resolve(socket))
      socket.once('error', reject)
    })
  }
}
