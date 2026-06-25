import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'

// Each running emulator writes a discovery .ini that maps its console port (the ADB serial) to its
// gRPC port. We read it to learn an emulator's actual gRPC port instead of assuming a fixed 8554 —
// the bug that made concurrent emulators on one Mac all collide on 8554 and share one stream.
// macOS path; overridable for tests / non-default emulator homes.
const DEFAULT_RUNNING_DIR = path.join(os.homedir(), 'Library', 'Caches', 'TemporaryItems', 'avd', 'running')

export function runningDir(): string {
  return process.env.TAPFLOW_EMULATOR_RUNNING_DIR || DEFAULT_RUNNING_DIR
}

export interface RunningEmulator {
  consolePort: number | null // port.serial → ADB serial is `emulator-<consolePort>`
  grpcPort: number | null    // grpc.port
  avdId: string | null       // avd.id
}

/** Parse one emulator discovery .ini. Pure — unit-testable without the filesystem. */
export function parseDiscoveryIni(text: string): RunningEmulator {
  const get = (key: string): string | null => {
    const re = new RegExp(`^${key.replace(/\./g, '\\.')}=(.*)$`, 'm')
    const m = text.match(re)
    return m ? m[1].trim() : null
  }
  const num = (s: string | null): number | null => {
    if (s == null) return null
    const n = Number(s)
    return Number.isInteger(n) ? n : null
  }
  return {
    consolePort: num(get('port.serial')),
    grpcPort: num(get('grpc.port')),
    avdId: get('avd.id'),
  }
}

/** The console port encoded in an emulator serial (`emulator-5554` → 5554), or null if not an emulator. */
export function consolePortFromSerial(serial: string): number | null {
  const m = serial.match(/^emulator-(\d+)$/)
  return m ? Number(m[1]) : null
}

/** The gRPC port a running emulator advertises for the given serial, or null if not discoverable. */
export function discoverGrpcPort(serial: string, dir: string = runningDir()): number | null {
  const consolePort = consolePortFromSerial(serial)
  if (consolePort == null) return null
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('pid_') && f.endsWith('.ini'))
  } catch {
    return null // dir absent (no running emulators / non-default home)
  }
  for (const f of files) {
    try {
      const info = parseDiscoveryIni(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (info.consolePort === consolePort && info.grpcPort != null) return info.grpcPort
    } catch {
      /* skip unreadable/partial ini */
    }
  }
  return null
}

/** True if a TCP port can be bound on all interfaces (i.e. no emulator/process holds it yet). */
export function isTcpPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port) // no host → all interfaces, matching how the emulator binds `*:<grpc>`
  })
}
