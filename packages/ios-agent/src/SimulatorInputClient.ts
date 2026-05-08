import { existsSync, statSync, unlinkSync } from 'fs'
import { execFileSync, execFile } from 'child_process'
import { join } from 'path'
import type { ChromeGeometry } from './ScreenCaptureStreamer'

const SRC_DIR = join(__dirname, '..', 'src')
const SWIFT_SRC = join(SRC_DIR, 'input-helper.swift')
const BINARY = join(SRC_DIR, 'input-helper')

function ensureCompiled(): void {
  if (existsSync(BINARY)) {
    if (statSync(BINARY).mtimeMs >= statSync(SWIFT_SRC).mtimeMs) return
    console.error('[SimulatorInput] Swift source changed, recompiling...')
    unlinkSync(BINARY)
  }
  console.error('[SimulatorInput] compiling input-helper...')
  execFileSync('swiftc', [SWIFT_SRC, '-o', BINARY, '-framework', 'Cocoa'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  console.error('[SimulatorInput] compiled OK')
}

export class SimulatorInputClient {
  private readonly args: string[]

  constructor(geometry: ChromeGeometry) {
    this.args = [
      String(geometry.compositeWidth),
      String(geometry.compositeHeight),
      String(geometry.screenX),
      String(geometry.screenY),
      String(geometry.screenWidth),
      String(geometry.screenHeight),
    ]
  }

  tap(normX: number, normY: number): void {
    ensureCompiled()
    execFile(
      BINARY,
      ['tap', ...this.args, String(normX), String(normY)],
      (err, _stdout, stderr) => {
        if (err) console.error('[agent] tap failed:', stderr || err.message)
      },
    )
  }

  swipe(fromX: number, fromY: number, toX: number, toY: number): void {
    ensureCompiled()
    execFile(
      BINARY,
      ['swipe', ...this.args, String(fromX), String(fromY), String(toX), String(toY)],
      (err, _stdout, stderr) => {
        if (err) console.error('[agent] swipe failed:', stderr || err.message)
      },
    )
  }
}
