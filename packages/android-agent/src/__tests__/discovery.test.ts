import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseDiscoveryIni, consolePortFromSerial, discoverGrpcPort } from '../emulator/discovery'

// A real emulator discovery .ini (trimmed).
const SAMPLE = `emulator.build=15507667
avd.id=Galaxy_S23_API_35
port.serial=5554
port.adb=5555
avd.name=Galaxy S23 API 35
cmdline="emulator" "-avd" "Galaxy_S23_API_35" "-grpc" "8554"
grpc.port=8554
`

describe('parseDiscoveryIni', () => {
  it('extracts console port, grpc port, and avd id', () => {
    expect(parseDiscoveryIni(SAMPLE)).toEqual({ consolePort: 5554, grpcPort: 8554, avdId: 'Galaxy_S23_API_35' })
  })

  it('returns nulls when fields are absent', () => {
    expect(parseDiscoveryIni('emulator.build=1\n')).toEqual({ consolePort: null, grpcPort: null, avdId: null })
  })

  it('does not confuse port.adb with port.serial', () => {
    expect(parseDiscoveryIni(SAMPLE).consolePort).toBe(5554) // not 5555
  })

  it('reads a non-default grpc port (the multi-emulator fix)', () => {
    const ini = 'port.serial=5556\ngrpc.port=8556\n'
    expect(parseDiscoveryIni(ini)).toMatchObject({ consolePort: 5556, grpcPort: 8556 })
  })
})

describe('consolePortFromSerial', () => {
  it('parses emulator-NNNN', () => {
    expect(consolePortFromSerial('emulator-5554')).toBe(5554)
    expect(consolePortFromSerial('emulator-5582')).toBe(5582)
  })
  it('returns null for non-emulator serials', () => {
    expect(consolePortFromSerial('R5CT30XXXX')).toBeNull()
    expect(consolePortFromSerial('emulator-')).toBeNull()
  })
})

describe('discoverGrpcPort', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

  function makeRunningDir(inis: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-disco-'))
    dirs.push(dir)
    for (const [name, text] of Object.entries(inis)) fs.writeFileSync(path.join(dir, name), text)
    return dir
  }

  it('returns the grpc port for the matching serial', () => {
    const dir = makeRunningDir({
      'pid_100.ini': 'port.serial=5554\ngrpc.port=8554\n',
      'pid_200.ini': 'port.serial=5556\ngrpc.port=8556\n',
    })
    expect(discoverGrpcPort('emulator-5554', dir)).toBe(8554)
    expect(discoverGrpcPort('emulator-5556', dir)).toBe(8556)
  })

  it('returns null when no running emulator matches the serial', () => {
    const dir = makeRunningDir({ 'pid_100.ini': 'port.serial=5554\ngrpc.port=8554\n' })
    expect(discoverGrpcPort('emulator-5600', dir)).toBeNull()
  })

  it('returns null for a missing directory or non-emulator serial', () => {
    expect(discoverGrpcPort('emulator-5554', '/no/such/dir')).toBeNull()
    expect(discoverGrpcPort('physical-device')).toBeNull()
  })
})
