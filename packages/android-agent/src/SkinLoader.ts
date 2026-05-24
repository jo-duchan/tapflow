import { readFileSync, existsSync, unlinkSync } from 'fs'
import { join, isAbsolute } from 'path'
import { inflateSync } from 'zlib'
import { execSync } from 'child_process'
import os from 'os'
import { createLogger } from '@tapflowio/agent-core'

const logger = createLogger('android-agent:skin')

export interface SkinData {
  backPng: string  // base64-encoded image (webp)
  screenRect: { x: number; y: number; width: number; height: number }
  compositeSize: { width: number; height: number }
  cornerRadius: number
}

interface ParsedLayout {
  backgroundImage: string
  maskImage?: string
  displayWidth: number
  displayHeight: number
  cornerRadius: number
  compositeWidth: number
  compositeHeight: number
  screenX: number
  screenY: number
}

interface Block {
  values: Record<string, string>
  children: Record<string, Block>
}

export function loadSkin(
  avdName: string,
  avdDir = join(os.homedir(), '.android', 'avd'),
): SkinData | null {
  try {
    const configPath = join(avdDir, `${avdName}.avd`, 'config.ini')
    if (!existsSync(configPath)) return null

    const config = parseIni(readFileSync(configPath, 'utf-8'))
    const skinName = config['skin.name']
    const rawSkinPath = config['skin.path']

    if (!skinName || skinName === '_no_skin' || !rawSkinPath) return null

    // skin.path may be relative (e.g. "skins/pixel_9") — resolve against ANDROID_HOME
    const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || ''
    const skinPath = isAbsolute(rawSkinPath) ? rawSkinPath : join(androidHome, rawSkinPath)

    const layoutPath = join(skinPath, 'layout')
    if (!existsSync(layoutPath)) return null

    const layout = parseLayout(readFileSync(layoutPath, 'utf-8'))
    if (!layout) return null

    const bgPath = join(skinPath, layout.backgroundImage)
    if (!existsSync(bgPath)) return null

    // If layout has no corner_radius but skin provides mask.webp, detect radius from mask.
    // mask.webp for modern Pixel skins has opaque corner areas and a transparent screen interior.
    // The first transparent pixel on the top row = corner radius in display pixels.
    let cornerRadius = layout.cornerRadius
    if (cornerRadius === 0 && layout.maskImage) {
      const maskPath = join(skinPath, layout.maskImage)
      if (existsSync(maskPath)) {
        cornerRadius = detectMaskCornerRadius(maskPath, layout.displayWidth)
      }
    }

    return {
      backPng: readFileSync(bgPath).toString('base64'),
      screenRect: { x: layout.screenX, y: layout.screenY, width: layout.displayWidth, height: layout.displayHeight },
      compositeSize: { width: layout.compositeWidth, height: layout.compositeHeight },
      cornerRadius,
    }
  } catch (e) {
    logger.warn('skin load failed:', (e as Error).message)
    return null
  }
}

// Uses sips (macOS built-in) to export the first row of the mask image as PNG,
// then scans for the first fully-transparent pixel to determine the screen corner radius.
function detectMaskCornerRadius(maskPath: string, displayWidth: number): number {
  const tmpPng = join(os.tmpdir(), `tapflow_mask_cr_${process.pid}.png`)
  try {
    execSync(
      `sips -s format png --cropToHeightWidth 1 ${displayWidth} "${maskPath}" --out "${tmpPng}" 2>/dev/null`,
      { stdio: 'pipe', timeout: 5000 },
    )
    const buf = readFileSync(tmpPng)

    // Collect all IDAT chunks and decompress
    const idatParts: Buffer[] = []
    let pos = 8
    while (pos + 12 <= buf.length) {
      const len = buf.readUInt32BE(pos)
      const type = buf.subarray(pos + 4, pos + 8).toString()
      if (type === 'IDAT') idatParts.push(buf.subarray(pos + 8, pos + 8 + len))
      if (type === 'IEND') break
      pos += 12 + len
    }
    if (!idatParts.length) return 0

    const raw = inflateSync(Buffer.concat(idatParts))
    // First scanline: 1 filter byte + W×4 RGBA bytes. Only handle filter 0 (None).
    if (raw[0] !== 0) return 0
    for (let x = 0; x < displayWidth; x++) {
      if (raw[1 + x * 4 + 3] === 0) return x
    }
    return 0
  } catch {
    return 0
  } finally {
    try { unlinkSync(tmpPng) } catch { /* cleanup best-effort */ }
  }
}

function parseIni(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq === -1) continue
    result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return result
}

// Exported for testing
export function parseLayout(text: string): ParsedLayout | null {
  const root = parseBlock(text.split('\n'), 0).block

  const partsDevice = root.children['parts']?.children['device']
  const partsPortrait = root.children['parts']?.children['portrait']
  const layoutsPortrait = root.children['layouts']?.children['portrait']

  if (!partsDevice || !layoutsPortrait) return null

  const displayWidth = num(partsDevice.children['display']?.values['width'])
  const displayHeight = num(partsDevice.children['display']?.values['height'])
  const cornerRadius = num(partsDevice.children['display']?.values['corner_radius'])
  const backgroundImage = partsPortrait?.children['background']?.values['image'] ?? ''
  const maskImage = partsPortrait?.children['foreground']?.values['mask'] || undefined
  const compositeWidth = num(layoutsPortrait.values['width'])
  const compositeHeight = num(layoutsPortrait.values['height'])

  if (!displayWidth || !displayHeight || !backgroundImage || !compositeWidth || !compositeHeight) return null

  // Find the part block whose name=device to determine screen position in the composite
  let screenX = 0
  let screenY = 0
  for (const part of Object.values(layoutsPortrait.children)) {
    if (part.values['name'] === 'device') {
      screenX = num(part.values['x'])
      screenY = num(part.values['y'])
      break
    }
  }

  return { backgroundImage, maskImage, displayWidth, displayHeight, cornerRadius, compositeWidth, compositeHeight, screenX, screenY }
}

function num(v: string | undefined): number {
  if (!v) return 0
  const n = parseInt(v, 10)
  return isNaN(n) ? 0 : n
}

function parseBlock(lines: string[], start: number): { block: Block; end: number } {
  const block: Block = { values: {}, children: {} }
  let i = start
  while (i < lines.length) {
    const line = lines[i].trim()
    i++
    if (!line || line.startsWith('#')) continue
    if (line === '}') break
    if (line.endsWith('{')) {
      const key = line.slice(0, -1).trim()
      const inner = parseBlock(lines, i)
      block.children[key] = inner.block
      i = inner.end
    } else {
      const sp = line.indexOf(' ')
      if (sp !== -1) {
        const key = line.slice(0, sp)
        if (!(key in block.values)) block.values[key] = line.slice(sp + 1).trim()
      }
    }
  }
  return { block, end: i }
}
