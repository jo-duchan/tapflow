import { describe, it, expect, afterEach, vi } from 'vitest'
import { PassThrough } from 'stream'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pipeUpload, StorageFullError } from '../lib/uploads'

// `stream.pipe(writer)` leaves the writer open and the partial file on disk when the source fails. Every
// upload handler writes through this instead.
describe('pipeUpload', () => {
  let dir = ''
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  it('writes the whole upload and resolves', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-pipe-'))
    const dest = path.join(dir, 'f')
    const src = new PassThrough()
    const written = pipeUpload(src, dest, 'test')
    src.end('complete')
    await written
    expect(fs.readFileSync(dest, 'utf8')).toBe('complete')
  })

  it('on a failed source, closes the writer, removes the partial file and rejects', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-pipe-'))
    const dest = path.join(dir, 'f')
    const src = new PassThrough()
    const written = pipeUpload(src, dest, 'test')
    src.write('partial')
    await new Promise((r) => setTimeout(r, 20))
    src.destroy(new Error('source failed'))
    await expect(written).rejects.toThrow('source failed')
    await new Promise((r) => setTimeout(r, 20))
    expect(fs.existsSync(dest)).toBe(false)
  })

  // An error before the asynchronous open completes: removing the file at once deleted nothing, and the open
  // then created it.
  it('removes the file even when the source fails before the file is open', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-pipe-'))
    const dest = path.join(dir, 'f')
    const src = new PassThrough()
    const written = pipeUpload(src, dest, 'test')
    src.destroy(new Error('early'))
    await expect(written).rejects.toThrow('early')
    expect(fs.existsSync(dest)).toBe(false)
  })

  describe('free-space floor', () => {
    afterEach(() => {
      vi.restoreAllMocks()
      delete process.env.TAPFLOW_MIN_FREE_DISK_BYTES
    })

    it('refuses before writing when the disk is already below the floor, and still drains the source', async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-pipe-'))
      process.env.TAPFLOW_MIN_FREE_DISK_BYTES = String(Number.MAX_SAFE_INTEGER)
      const dest = path.join(dir, 'f')
      const src = new PassThrough()
      const written = pipeUpload(src, dest, 'test')
      const ended = new Promise<void>((resolve) => src.on('end', () => resolve()))
      src.end(Buffer.alloc(64 * 1024))
      await expect(written).rejects.toBeInstanceOf(StorageFullError)
      await ended
      expect(fs.existsSync(dest)).toBe(false)
    })

    // What the reported attack needs: the check at the start alone lets one upload run the disk out.
    it('stops an upload that brings the disk below the floor while it runs, and removes what it wrote', async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-pipe-'))
      process.env.TAPFLOW_MIN_FREE_DISK_BYTES = String(1024 * 1024 * 1024)
      const real = fs.statfsSync(dir)
      let calls = 0
      // Plenty free at the start, then below the floor from the first re-check on.
      vi.spyOn(fs, 'statfsSync').mockImplementation(() => {
        calls++
        return { ...real, bsize: 1, bavail: calls === 1 ? 10 * 1024 * 1024 * 1024 : 512 * 1024 * 1024 } as fs.StatsFs
      })
      const dest = path.join(dir, 'f')
      const src = new PassThrough()
      const written = pipeUpload(src, dest, 'test')
      const ended = new Promise<void>((resolve) => src.on('end', () => resolve()))
      for (let i = 0; i < 4; i++) src.write(Buffer.alloc(512 * 1024))
      src.end()
      await expect(written).rejects.toBeInstanceOf(StorageFullError)
      await ended
      expect(calls).toBeGreaterThan(1)
      await new Promise((r) => setTimeout(r, 20))
      expect(fs.existsSync(dest)).toBe(false)
    })

    it('is not refused when the filesystem cannot be asked', async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-pipe-'))
      vi.spyOn(fs, 'statfsSync').mockImplementation(() => { throw new Error('ENOSYS') })
      process.env.TAPFLOW_MIN_FREE_DISK_BYTES = String(Number.MAX_SAFE_INTEGER)
      const dest = path.join(dir, 'f')
      const src = new PassThrough()
      const written = pipeUpload(src, dest, 'test')
      src.end('complete')
      await written
      expect(fs.readFileSync(dest, 'utf8')).toBe('complete')
    })
  })

  // A writer error unpipes the source; left unread it holds the multipart parser short of 'finish'.
  it('keeps draining the source after a failed write', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-pipe-'))
    const src = new PassThrough()
    const written = pipeUpload(src, path.join(dir, 'missing', 'f'), 'test')
    await expect(written).rejects.toThrow()
    const ended = new Promise<void>((resolve) => src.on('end', () => resolve()))
    src.write(Buffer.alloc(64 * 1024))
    src.end()
    await ended
  })
})
