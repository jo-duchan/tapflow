import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const DEVICE_TYPES_DIR = '/Library/Developer/CoreSimulator/Profiles/DeviceTypes'
const CHROME_MAP_PATH = '/Library/Developer/DeviceKit/chrome_map.plist'
const CHROME_DIR = '/Library/Developer/DeviceKit/Chrome'

export interface ChromeRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ChromeButton {
  name: string
  accessibilityTitle: string
  anchor: string
  normalOffset: { x: number; y: number }
}

export interface ChromeData {
  bezelPng: string
  bezelWidth: number
  bezelHeight: number
  screenRect: ChromeRect
  logicalWidth: number   // screen width in iOS logical pixels (pt)
  logicalHeight: number  // screen height in iOS logical pixels (pt)
  buttons: ChromeButton[]
}

function readPlistAsJson(filePath: string): unknown {
  const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', filePath])
  return JSON.parse(json.toString())
}

function getSipsSize(filePath: string): { width: number; height: number } {
  const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', filePath]).toString()
  const w = out.match(/pixelWidth:\s*([\d.]+)/)
  const h = out.match(/pixelHeight:\s*([\d.]+)/)
  return { width: Math.round(parseFloat(w![1])), height: Math.round(parseFloat(h![1])) }
}

export class DeviceChromeLoader {
  load(deviceName: string): ChromeData | null {
    try {
      const simdevicetypePath = join(DEVICE_TYPES_DIR, `${deviceName}.simdevicetype`)
      if (!existsSync(simdevicetypePath)) return null

      const profile = readPlistAsJson(
        join(simdevicetypePath, 'Contents', 'Resources', 'profile.plist'),
      ) as { modelIdentifier: string }

      const chromeMap = readPlistAsJson(CHROME_MAP_PATH) as Record<string, { ChromeIdentifier: string }>
      const entry = chromeMap[profile.modelIdentifier]
      if (!entry) return null

      const chromeName = entry.ChromeIdentifier.split('.').pop()!
      const resourcesDir = join(CHROME_DIR, `${chromeName}.devicechrome`, 'Contents', 'Resources')
      const compositePdf = join(resourcesDir, 'PhoneComposite.pdf')
      if (!existsSync(compositePdf)) return null

      const chromeJson = JSON.parse(readFileSync(join(resourcesDir, 'chrome.json'), 'utf-8')) as {
        images: {
          sizing: { leftWidth: number; rightWidth: number; topHeight: number; bottomHeight: number }
        }
        inputs?: Array<{
          name: string
          accessibilityTitle?: string
          anchor: string
          offsets: { normal: { x: number; y: number } }
        }>
      }
      const { leftWidth, rightWidth, topHeight, bottomHeight } = chromeJson.images.sizing

      // rasterize at 2x (sips -z expects height then width)
      const pdfSize = getSipsSize(compositePdf)
      const pngPath = join(tmpdir(), `tapflow-bezel-${chromeName}.png`)
      execFileSync('sips', [
        '-s', 'format', 'png',
        '-z', String(pdfSize.height * 2), String(pdfSize.width * 2),
        compositePdf,
        '--out', pngPath,
      ])
      const pngSize = getSipsSize(pngPath)
      const scale = pngSize.width / pdfSize.width

      const screenRect: ChromeRect = {
        x: Math.round(leftWidth * scale),
        y: Math.round(topHeight * scale),
        width: Math.round((pdfSize.width - leftWidth - rightWidth) * scale),
        height: Math.round((pdfSize.height - topHeight - bottomHeight) * scale),
      }

      const buttons: ChromeButton[] = (chromeJson.inputs ?? []).map((btn) => ({
        name: btn.name,
        accessibilityTitle: btn.accessibilityTitle ?? btn.name,
        anchor: btn.anchor,
        normalOffset: {
          x: Math.round(btn.offsets.normal.x * scale),
          y: Math.round(btn.offsets.normal.y * scale),
        },
      }))

      return {
        bezelPng: readFileSync(pngPath).toString('base64'),
        bezelWidth: pngSize.width,
        bezelHeight: pngSize.height,
        screenRect,
        logicalWidth:  Math.round(pdfSize.width  - leftWidth  - rightWidth),
        logicalHeight: Math.round(pdfSize.height - topHeight  - bottomHeight),
        buttons,
      }
    } catch {
      return null
    }
  }
}
