import net from 'net'
import path from 'path'
import { fileURLToPath } from 'url'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { ScrcpyVideo } from './ScrcpyVideo.js'
import { ScrcpyControl } from './ScrcpyControl.js'
import type { ScrcpyDeviceInfo } from './ScrcpyVideo.js'

const execFileAsync = promisify(execFile)

const SCRCPY_SERVER_VERSION = '3.1'
const DEVICE_PATH = '/data/local/tmp/scrcpy-server.jar'
// Fixed scid makes the abstract socket name predictable: scrcpy_<scid_hex8>
const SCID = '00000000'
const SOCKET_NAME = `scrcpy_${SCID}`

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
  private videoSocket: net.Socket | null = null
  private controlSocket: net.Socket | null = null
  private _video: ScrcpyVideo | null = null
  private _control: ScrcpyControl | null = null
  private port = 0

  get video(): ScrcpyVideo {
    if (!this._video) throw new Error('ScrcpySession not started')
    return this._video
  }

  get control(): ScrcpyControl {
    if (!this._control) throw new Error('ScrcpySession not started')
    return this._control
  }

  async start(serial: string): Promise<ScrcpyDeviceInfo> {
    const adb = getAdbPath()
    const port = allocatePort()
    this.port = port
    const jarPath = getServerJarPath()

    console.log(`[scrcpy] push ${jarPath} → ${serial}:${DEVICE_PATH}`)
    await execFileAsync(adb, ['-s', serial, 'push', jarPath, DEVICE_PATH])

    console.log(`[scrcpy] starting server on ${serial} (socket=${SOCKET_NAME})`)
    const serverProc = spawn(adb, [
      '-s', serial, 'shell',
      `CLASSPATH=${DEVICE_PATH} app_process / com.genymobile.scrcpy.Server`,
      SCRCPY_SERVER_VERSION,
      `scid=${SCID}`,
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
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    // Log server output for debugging
    serverProc.stdout?.on('data', (d: Buffer) => console.log('[scrcpy-server]', d.toString().trim()))
    serverProc.stderr?.on('data', (d: Buffer) => console.error('[scrcpy-server]', d.toString().trim()))
    serverProc.unref()

    // Wait for server to bind the abstract socket
    await new Promise((r) => setTimeout(r, 1500))

    console.log(`[scrcpy] forward tcp:${port} → localabstract:${SOCKET_NAME}`)
    await execFileAsync(adb, ['-s', serial, 'forward', `tcp:${port}`, `localabstract:${SOCKET_NAME}`])

    // scrcpy accepts connections sequentially on the same socket:
    // 1st accept() → video stream, 2nd accept() → control stream
    console.log('[scrcpy] connecting video socket…')
    this.videoSocket = await this.connectTcp(port)

    console.log('[scrcpy] connecting control socket…')
    this.controlSocket = await this.connectTcp(port)

    console.log('[scrcpy] reading device info…')
    this._video = new ScrcpyVideo(this.videoSocket)
    const info = await this._video.deviceInfo()

    this._control = new ScrcpyControl(this.controlSocket, info.width, info.height)
    console.log(`[scrcpy] ready — ${info.deviceName} ${info.width}×${info.height}`)
    return info
  }

  stop(serial: string): void {
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
      const socket = net.connect(port, '127.0.0.1', () => resolve(socket))
      socket.once('error', reject)
    })
  }
}
