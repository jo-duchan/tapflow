// Button layout logic (computeButtonLayout) is derived from baguette (Apache-2.0):
// https://github.com/tddworks/baguette
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const CHROME_MAP_PATH = '/Library/Developer/DeviceKit/chrome_map.plist'
const CHROME_DIR = '/Library/Developer/DeviceKit/Chrome'
const PROFILES_DIR = '/Library/Developer/CoreSimulator/Profiles/DeviceTypes'

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
  normalOffset: { x: number; y: number }  // button center in expanded composite 2× px
}

export interface ChromeData {
  framePng: string         // composite + buttons baked in at 2× — screen hole transparent
  bezelWidth: number       // composite minus devicePadding, at 2× px
  bezelHeight: number
  compositeWidth: number   // expanded canvas width (composite + button margins), at 2× px
  compositeHeight: number  // expanded canvas height, at 2× px
  padding: { left: number; right: number; top: number; bottom: number }  // devicePadding at 2× px
  screenRect: ChromeRect   // screen position in expanded composite coordinate space, at 2× px
  screenCornerRadius: number  // screen corner radius in 2× px (0 if device has no rounded corners)
  logicalWidth: number     // screen width in iOS logical pixels (pt)
  logicalHeight: number    // screen height in iOS logical pixels (pt)
  buttons: ChromeButton[]
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Button layout
// ---------------------------------------------------------------------------

interface RawInput {
  name: string
  accessibilityTitle?: string
  anchor?: string
  align?: string
  image: string
  onTop?: boolean
  offsets?: {
    normal: { x: number; y: number }
    rollover?: { x: number; y: number }
  }
}

interface ButtonDrawData {
  pdfPath: string
  topLeftX: number   // 1× pts, in expanded canvas (top-left origin)
  topLeftY: number
  onTop: boolean
}

interface ButtonLayout {
  margins: { left: number; top: number; right: number; bottom: number }
  drawData: ButtonDrawData[]
  buttons: ChromeButton[]
}

// Mirrors baguette's LiveChromes.computeMargins + buttonTopLeft.
// compositeW/H = device body dimensions in 1× PDF pts (before button margin expansion).
// For composite PDF: pdfSize.width / pdfSize.height.
// For nine-slice: cornerW*2+screenW / cornerH*2+screenH.
function computeButtonLayout(
  inputs: RawInput[],
  resourcesDir: string,
  compositeW: number,
  compositeH: number,
  scale = 2,
): ButtonLayout {
  const margins = { left: 0, top: 0, right: 0, bottom: 0 }

  interface BtnInfo { input: RawInput; w: number; h: number; roll: { x: number; y: number } }
  const infos: BtnInfo[] = []

  for (const inp of inputs) {
    if (!inp.offsets) continue
    const pdfPath = join(resourcesDir, `${inp.image}.pdf`)
    if (!existsSync(pdfPath)) continue
    try {
      const size = getSipsSize(pdfPath)
      const roll = inp.offsets.rollover ?? inp.offsets.normal
      infos.push({ input: inp, w: size.width, h: size.height, roll })
    } catch { /* skip unmeasurable assets */ }
  }

  // Pass 1 — margins (baguette's computeMargins, rollover offset)
  for (const { input: inp, w, h, roll } of infos) {
    switch (inp.anchor ?? 'left') {
      case 'left':   margins.left   = Math.max(margins.left,   Math.max(w - roll.x, 0));        break
      case 'right':  margins.right  = Math.max(margins.right,  Math.max(w + roll.x, 0));         break
      case 'top':    margins.top    = Math.max(margins.top,    Math.max(-(roll.y - h / 2), 0)); break
      // bottom-anchored buttons with negative y sit inside the bezel — no canvas expansion needed
      case 'bottom': margins.bottom = Math.max(margins.bottom, Math.max(roll.y + h / 2, 0));    break
    }
  }

  // Pass 2 — button top-left positions and normalOffset centers (baguette's buttonTopLeft)
  const drawData: ButtonDrawData[] = []
  const buttons: ChromeButton[] = []

  for (const { input: inp, w, h, roll } of infos) {
    const mL = margins.left
    const mT = margins.top
    let centerX: number
    let topY: number

    switch (inp.anchor ?? 'left') {
      case 'left':
        centerX = mL + roll.x
        topY    = mT + roll.y
        break
      case 'right':
        centerX = mL + compositeW + roll.x
        topY    = mT + roll.y
        break
      case 'bottom': {
        // centerX: relative to device body center for center-aligned buttons (e.g. home)
        const align = inp.align ?? 'leading'
        centerX = align === 'center'   ? mL + compositeW / 2 + roll.x
                : align === 'trailing' ? mL + compositeW + roll.x
                :                        mL + roll.x
        // topY: measured from the BOTTOM of the device body downward (offset is negative = inside)
        topY = mT + compositeH + roll.y
        break
      }
      case 'top': {
        const align = inp.align ?? 'leading'
        centerX = align === 'center'   ? mL + compositeW / 2 + roll.x
                : align === 'trailing' ? mL + compositeW + roll.x
                :                        mL + roll.x
        topY = mT + roll.y
        break
      }
      default:
        centerX = mL + roll.x
        topY    = mT + roll.y
    }

    drawData.push({
      pdfPath:  join(resourcesDir, `${inp.image}.pdf`),
      topLeftX: centerX - w / 2,
      topLeftY: topY,
      onTop:    inp.onTop ?? false,
    })

    // normalOffset: button center in expanded 2× composite px for hit-testing
    const nx = inp.offsets!.normal.x
    const ny = inp.offsets!.normal.y
    let normalCX: number
    let normalCY: number

    switch (inp.anchor ?? 'left') {
      case 'right':
        normalCX = mL + compositeW + nx
        normalCY = mT + ny
        break
      case 'bottom': {
        const align = inp.align ?? 'leading'
        normalCX = align === 'center'   ? mL + compositeW / 2 + nx
                 : align === 'trailing' ? mL + compositeW + nx
                 :                        mL + nx
        // center Y: bottom of body + offset (negative) + half height
        normalCY = mT + compositeH + ny + h / 2
        break
      }
      default: // left / top / fallback — use convention from baguette (x=center, y=top edge)
        normalCX = mL + nx
        normalCY = mT + ny
    }

    buttons.push({
      name: inp.name,
      accessibilityTitle: inp.accessibilityTitle ?? inp.name,
      anchor: inp.anchor ?? 'left',
      normalOffset: {
        x: Math.round(normalCX * scale),
        y: Math.round(normalCY * scale),
      },
    })
  }

  return { margins, drawData, buttons }
}

// ---------------------------------------------------------------------------
// Frame PNG rendering — composite PDF path
// Renders composite PDF + physical button PDFs into one PNG at 2×.
// ---------------------------------------------------------------------------

function renderFramePng(
  compositePdf: string,
  outPath: string,
  margins: { left: number; top: number; right: number; bottom: number },
  buttons: ButtonDrawData[],
): void {
  const behind = buttons.filter(b => !b.onTop)
  const onTop  = buttons.filter(b => b.onTop)

  function btnLiteral(b: ButtonDrawData): string {
    return `(path: ${JSON.stringify(b.pdfPath)}, x: ${b.topLeftX}, y: ${b.topLeftY})`
  }

  const SCRIPT = `
import Foundation
import CoreGraphics
import ImageIO

let args  = CommandLine.arguments
let src   = args[1]
let dst   = args[2]
let scale: CGFloat = 2

let mL: CGFloat = ${margins.left}
let mT: CGFloat = ${margins.top}
let mR: CGFloat = ${margins.right}
let mB: CGFloat = ${margins.bottom}

// (pdf path, topLeftX in 1× expanded-canvas pts, topLeftY in 1× expanded-canvas pts)
let behindBtns: [(path: String, x: CGFloat, y: CGFloat)] = [
  ${behind.map(btnLiteral).join(',\n  ')}
]
let onTopBtns: [(path: String, x: CGFloat, y: CGFloat)] = [
  ${onTop.map(btnLiteral).join(',\n  ')}
]

let pdf  = CGPDFDocument(URL(fileURLWithPath: src) as CFURL)!
let page = pdf.page(at: 1)!
let box  = page.getBoxRect(.mediaBox)

let cW   = box.width
let cH   = box.height
let canW = Int((cW + mL + mR) * scale)
let canH = Int((cH + mT + mB) * scale)

let ctx = CGContext(
  data: nil, width: canW, height: canH,
  bitsPerComponent: 8, bytesPerRow: 0,
  space: CGColorSpaceCreateDeviceRGB(),
  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue).rawValue
)!

func drawPage(_ pg: CGPDFPage, tlX: CGFloat, tlY: CGFloat) {
  let b = pg.getBoxRect(.mediaBox)
  ctx.saveGState()
  ctx.translateBy(
    x: tlX * scale,
    y: CGFloat(canH) - (tlY + b.height) * scale
  )
  ctx.scaleBy(x: scale, y: scale)
  ctx.drawPDFPage(pg)
  ctx.restoreGState()
}

func loadButton(_ entry: (path: String, x: CGFloat, y: CGFloat)) {
  guard let d = CGPDFDocument(URL(fileURLWithPath: entry.path) as CFURL),
        let p = d.page(at: 1) else { return }
  drawPage(p, tlX: entry.x, tlY: entry.y)
}

for btn in behindBtns { loadButton(btn) }
drawPage(page, tlX: mL, tlY: mT)
for btn in onTopBtns  { loadButton(btn) }

let img  = ctx.makeImage()!
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: dst) as CFURL, "public.png" as CFString, 1, nil)!
CGImageDestinationAddImage(dest, img, nil)
CGImageDestinationFinalize(dest)
`

  const scriptPath = join(tmpdir(), 'tapflow-frame-png.swift')
  writeFileSync(scriptPath, SCRIPT)
  execFileSync('swift', [scriptPath, compositePdf, outPath])
}

// ---------------------------------------------------------------------------
// Frame PNG rendering — nine-slice path
// Rasterizes 8 PDF slices to bitmaps, composes them around the screen hole,
// then draws physical button PDFs. Matches baguette's compose9Slice approach.
// ---------------------------------------------------------------------------

function renderNineSlicePng(
  slicePaths: {
    topLeft: string; top: string; topRight: string; right: string
    bottomRight: string; bottom: string; bottomLeft: string; left: string
  },
  outPath: string,
  screenW: number,
  screenH: number,
  cornerW: number,
  cornerH: number,
  margins: { left: number; top: number; right: number; bottom: number },
  buttons: ButtonDrawData[],
): void {
  const behind = buttons.filter(b => !b.onTop)
  const onTop  = buttons.filter(b => b.onTop)

  function btnLiteral(b: ButtonDrawData): string {
    return `(path: ${JSON.stringify(b.pdfPath)}, x: ${b.topLeftX}, y: ${b.topLeftY})`
  }

  const SCRIPT = `
import Foundation
import CoreGraphics
import ImageIO

let screenW: CGFloat = ${screenW}
let screenH: CGFloat = ${screenH}
let cornerW: CGFloat = ${cornerW}
let cornerH: CGFloat = ${cornerH}
let mL: CGFloat = ${margins.left}
let mT: CGFloat = ${margins.top}
let mR: CGFloat = ${margins.right}
let mB: CGFloat = ${margins.bottom}
let scale: CGFloat = 2
let dst = CommandLine.arguments[1]

// Canvas size in pixels
let canW = Int((mL + cornerW + screenW + cornerW + mR) * scale)
let canH = Int((mT + cornerH + screenH + cornerH + mB) * scale)

let ctx = CGContext(
  data: nil, width: canW, height: canH,
  bitsPerComponent: 8, bytesPerRow: 0,
  space: CGColorSpaceCreateDeviceRGB(),
  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue).rawValue
)!

// Rasterize PDF to CGImage at 2× — used for bitmap-based stretching of slice pieces.
// drawPDFPage cannot non-uniformly scale PDF pages, so we rasterize first then use ctx.draw().
func rasterize(_ path: String) -> CGImage? {
  guard let doc = CGPDFDocument(URL(fileURLWithPath: path) as CFURL),
        let page = doc.page(at: 1) else { return nil }
  let box = page.getBoxRect(.mediaBox)
  let w = max(1, Int(ceil(box.width  * scale)))
  let h = max(1, Int(ceil(box.height * scale)))
  guard let rc = CGContext(
    data: nil, width: w, height: h,
    bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue).rawValue)
  else { return nil }
  rc.scaleBy(x: scale, y: scale)
  rc.drawPDFPage(page)
  return rc.makeImage()
}

// Draw bitmap image into target rect (1× pts, top-left origin).
// CGContext uses bottom-left origin, so Y is flipped.
func drawImg(_ img: CGImage, tlX: CGFloat, tlY: CGFloat, w: CGFloat, h: CGFloat) {
  ctx.draw(img, in: CGRect(
    x: tlX * scale,
    y: CGFloat(canH) - (tlY + h) * scale,
    width:  w * scale,
    height: h * scale
  ))
}

// Draw a PDF at top-left (1× pts) — used for buttons which don't need stretching.
func drawPDF(_ path: String, tlX: CGFloat, tlY: CGFloat) {
  guard let doc = CGPDFDocument(URL(fileURLWithPath: path) as CFURL),
        let page = doc.page(at: 1) else { return }
  let b = page.getBoxRect(.mediaBox)
  ctx.saveGState()
  ctx.translateBy(x: tlX * scale, y: CGFloat(canH) - (tlY + b.height) * scale)
  ctx.scaleBy(x: scale, y: scale)
  ctx.drawPDFPage(page)
  ctx.restoreGState()
}

// Slice image paths
let pathTL  = ${JSON.stringify(slicePaths.topLeft)}
let pathT   = ${JSON.stringify(slicePaths.top)}
let pathTR  = ${JSON.stringify(slicePaths.topRight)}
let pathR   = ${JSON.stringify(slicePaths.right)}
let pathBR  = ${JSON.stringify(slicePaths.bottomRight)}
let pathB   = ${JSON.stringify(slicePaths.bottom)}
let pathBL  = ${JSON.stringify(slicePaths.bottomLeft)}
let pathL   = ${JSON.stringify(slicePaths.left)}

let imgTL = rasterize(pathTL)
let imgT  = rasterize(pathT)
let imgTR = rasterize(pathTR)
let imgR  = rasterize(pathR)
let imgBR = rasterize(pathBR)
let imgB  = rasterize(pathB)
let imgBL = rasterize(pathBL)
let imgL  = rasterize(pathL)

// Button specs baked into script
let behindBtns: [(path: String, x: CGFloat, y: CGFloat)] = [
  ${behind.map(btnLiteral).join(',\n  ')}
]
let onTopBtns: [(path: String, x: CGFloat, y: CGFloat)] = [
  ${onTop.map(btnLiteral).join(',\n  ')}
]

// Draw behind-buttons first
for btn in behindBtns { drawPDF(btn.path, tlX: btn.x, tlY: btn.y) }

// Nine-slice composition — device body starts at (mL, mT) in the expanded canvas
let bx = mL
let by = mT

// Top row
if let img = imgTL { drawImg(img, tlX: bx,                   tlY: by,                    w: cornerW, h: cornerH) }
if let img = imgT  { drawImg(img, tlX: bx + cornerW,         tlY: by,                    w: screenW, h: cornerH) }
if let img = imgTR { drawImg(img, tlX: bx + cornerW + screenW, tlY: by,                  w: cornerW, h: cornerH) }

// Middle row (screen hole at bx+cornerW, by+cornerH — left transparent)
if let img = imgL  { drawImg(img, tlX: bx,                   tlY: by + cornerH,          w: cornerW, h: screenH) }
if let img = imgR  { drawImg(img, tlX: bx + cornerW + screenW, tlY: by + cornerH,        w: cornerW, h: screenH) }

// Bottom row
if let img = imgBL { drawImg(img, tlX: bx,                   tlY: by + cornerH + screenH, w: cornerW, h: cornerH) }
if let img = imgB  { drawImg(img, tlX: bx + cornerW,         tlY: by + cornerH + screenH, w: screenW, h: cornerH) }
if let img = imgBR { drawImg(img, tlX: bx + cornerW + screenW, tlY: by + cornerH + screenH, w: cornerW, h: cornerH) }

// On-top buttons (e.g. home button drawn over bezel)
for btn in onTopBtns { drawPDF(btn.path, tlX: btn.x, tlY: btn.y) }

let outImg = ctx.makeImage()!
let dest   = CGImageDestinationCreateWithURL(URL(fileURLWithPath: dst) as CFURL, "public.png" as CFString, 1, nil)!
CGImageDestinationAddImage(dest, outImg, nil)
CGImageDestinationFinalize(dest)
`

  const scriptPath = join(tmpdir(), 'tapflow-frame-nineslice.swift')
  writeFileSync(scriptPath, SCRIPT)
  execFileSync('swift', [scriptPath, outPath])
}

// ---------------------------------------------------------------------------
// Model identifier and profile lookups
// ---------------------------------------------------------------------------

function modelIdentifierForType(typeIdentifier: string): string | null {
  try {
    const out = execFileSync('xcrun', ['simctl', 'list', 'devicetypes', '-j'])
    const types = (JSON.parse(out.toString())['devicetypes'] as Array<{
      identifier: string
      modelIdentifier?: string
    }>)
    return types.find(t => t.identifier === typeIdentifier)?.modelIdentifier ?? null
  } catch {
    return null
  }
}

// Reads mainScreenWidth/Height/Scale from CoreSimulator profile.plist.
// Returns logical point dimensions (physical px ÷ scale).
function loadProfileScreenSize(typeIdentifier: string): { width: number; height: number } | null {
  try {
    const out = execFileSync('xcrun', ['simctl', 'list', 'devicetypes', '-j'])
    const types = (JSON.parse(out.toString())['devicetypes'] as Array<{
      identifier: string
      name?: string
    }>)
    const name = types.find(t => t.identifier === typeIdentifier)?.name
    if (!name) return null

    const plistPath = join(PROFILES_DIR, `${name}.simdevicetype`, 'Contents', 'Resources', 'profile.plist')
    if (!existsSync(plistPath)) return null

    const data = readPlistAsJson(plistPath) as {
      mainScreenWidth?: number
      mainScreenHeight?: number
      mainScreenScale?: number
    }
    const w = data.mainScreenWidth
    const h = data.mainScreenHeight
    const s = data.mainScreenScale
    if (!w || !h || !s || s <= 0) return null
    return { width: Math.round(w / s), height: Math.round(h / s) }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// DeviceChromeLoader
// ---------------------------------------------------------------------------

export class DeviceChromeLoader {
  load(typeIdentifier: string): ChromeData | null {
    try {
      const modelId = modelIdentifierForType(typeIdentifier)
      if (!modelId) return null

      const chromeMap = readPlistAsJson(CHROME_MAP_PATH) as Record<string, { ChromeIdentifier: string }>
      const entry = chromeMap[modelId]
      if (!entry) return null

      const chromeName = entry.ChromeIdentifier.split('.').pop()!
      const resourcesDir = join(CHROME_DIR, `${chromeName}.devicechrome`, 'Contents', 'Resources')
      const chromeJsonPath = join(resourcesDir, 'chrome.json')
      if (!existsSync(chromeJsonPath)) return null

      const chromeJson = JSON.parse(readFileSync(chromeJsonPath, 'utf-8')) as {
        images: {
          // composite path
          composite?: string
          // nine-slice keys
          topLeft?: string; top?: string; topRight?: string; right?: string
          bottomRight?: string; bottom?: string; bottomLeft?: string; left?: string
          sizing: { leftWidth: number; rightWidth: number; topHeight: number; bottomHeight: number }
          devicePadding?: { left?: number; right?: number; top?: number; bottom?: number }
        }
        paths?: {
          simpleOutsideBorder?: { cornerRadiusX?: number; cornerRadiusY?: number }
        }
        inputs?: RawInput[]
      }

      const { leftWidth, rightWidth, topHeight, bottomHeight } = chromeJson.images.sizing
      const dp = chromeJson.images.devicePadding ?? {}
      const paddingLeft   = dp.left   ?? 0
      const paddingRight  = dp.right  ?? 0
      const paddingTop    = dp.top    ?? 0
      const paddingBottom = dp.bottom ?? 0

      const outerRadius  = chromeJson.paths?.simpleOutsideBorder?.cornerRadiusX ?? 0
      const rawInputs    = chromeJson.inputs ?? []
      const scale        = 2

      // -----------------------------------------------------------------------
      // Path A — composite PDF (all post-2020 iPhones)
      // -----------------------------------------------------------------------
      const compositePdf = join(resourcesDir, 'PhoneComposite.pdf')
      if (existsSync(compositePdf)) {
        const pdfSize = getSipsSize(compositePdf)
        const screenW = pdfSize.width  - leftWidth  - rightWidth
        const screenH = pdfSize.height - topHeight  - bottomHeight

        const bezelInset        = Math.max(leftWidth, topHeight)
        const screenCornerRadius1x = Math.max(0, outerRadius - bezelInset)

        const { margins: btnM, drawData, buttons } = computeButtonLayout(
          rawInputs, resourcesDir, pdfSize.width, pdfSize.height, scale,
        )

        const expandedW = pdfSize.width  + btnM.left + btnM.right
        const expandedH = pdfSize.height + btnM.top  + btnM.bottom

        const framePath = join(tmpdir(), `tapflow-frame-v2-${chromeName}.png`)
        if (!existsSync(framePath) || statSync(compositePdf).mtimeMs > statSync(framePath).mtimeMs) {
          renderFramePng(compositePdf, framePath, btnM, drawData)
        }

        const screenRect: ChromeRect = {
          x:      Math.round((leftWidth + btnM.left) * scale),
          y:      Math.round((topHeight + btnM.top)  * scale),
          width:  Math.round(screenW * scale),
          height: Math.round(screenH * scale),
        }

        return {
          framePng: readFileSync(framePath).toString('base64'),
          bezelWidth:  Math.round((pdfSize.width  - paddingLeft - paddingRight)  * scale),
          bezelHeight: Math.round((pdfSize.height - paddingTop  - paddingBottom) * scale),
          compositeWidth:  Math.round(expandedW * scale),
          compositeHeight: Math.round(expandedH * scale),
          padding: {
            left:   Math.round(paddingLeft   * scale),
            right:  Math.round(paddingRight  * scale),
            top:    Math.round(paddingTop    * scale),
            bottom: Math.round(paddingBottom * scale),
          },
          screenRect,
          screenCornerRadius: Math.round(screenCornerRadius1x * scale),
          logicalWidth:  Math.round(screenW),
          logicalHeight: Math.round(screenH),
          buttons,
        }
      }

      // -----------------------------------------------------------------------
      // Path B — nine-slice chrome (iPhone SE / older home-button devices)
      // Slices: topLeft/top/topRight/right/bottomRight/bottom/bottomLeft/left
      // -----------------------------------------------------------------------
      const imgs = chromeJson.images
      if (!imgs.topLeft || !imgs.top || !imgs.topRight || !imgs.right ||
          !imgs.bottomRight || !imgs.bottom || !imgs.bottomLeft || !imgs.left) {
        return null
      }

      const slicePaths = {
        topLeft:     join(resourcesDir, `${imgs.topLeft}.pdf`),
        top:         join(resourcesDir, `${imgs.top}.pdf`),
        topRight:    join(resourcesDir, `${imgs.topRight}.pdf`),
        right:       join(resourcesDir, `${imgs.right}.pdf`),
        bottomRight: join(resourcesDir, `${imgs.bottomRight}.pdf`),
        bottom:      join(resourcesDir, `${imgs.bottom}.pdf`),
        bottomLeft:  join(resourcesDir, `${imgs.bottomLeft}.pdf`),
        left:        join(resourcesDir, `${imgs.left}.pdf`),
      }

      // Ensure all slice PDFs exist
      if (!Object.values(slicePaths).every(existsSync)) return null

      // Corner PDF dimensions define the actual bezel insets used in composition.
      // The sizing.leftWidth/rightWidth in chrome.json is the VISIBLE bezel width
      // (interior of the corner), not the full corner PDF dimensions.
      const cornerSize = getSipsSize(slicePaths.topLeft)
      const cornerW = cornerSize.width
      const cornerH = cornerSize.height  // should equal topHeight from sizing

      // Get logical screen dimensions from CoreSimulator profile.plist
      const screenSize = loadProfileScreenSize(typeIdentifier)
      if (!screenSize) return null
      const screenW = screenSize.width
      const screenH = screenSize.height

      // Device body size = corners + screen (nine-slice composition)
      const compositeW = cornerW + screenW + cornerW
      const compositeH = cornerH + screenH + cornerH

      const bezelInset        = Math.max(leftWidth, topHeight)
      const screenCornerRadius1x = Math.max(0, outerRadius - bezelInset)

      const { margins: btnM, drawData, buttons } = computeButtonLayout(
        rawInputs, resourcesDir, compositeW, compositeH, scale,
      )

      const expandedW = compositeW + btnM.left + btnM.right
      const expandedH = compositeH + btnM.top  + btnM.bottom

      // Cache keyed by chrome name + screen dimensions
      const framePath = join(tmpdir(), `tapflow-frame-nineslice-${chromeName}-${screenW}x${screenH}.png`)
      const needsRender = !existsSync(framePath)
        || statSync(slicePaths.topLeft).mtimeMs > statSync(framePath).mtimeMs

      if (needsRender) {
        renderNineSlicePng(slicePaths, framePath, screenW, screenH, cornerW, cornerH, btnM, drawData)
      }

      // Screen hole position in expanded composite (screen starts after corner + left margin)
      const screenRect: ChromeRect = {
        x:      Math.round((btnM.left + cornerW) * scale),
        y:      Math.round((btnM.top  + cornerH) * scale),
        width:  Math.round(screenW * scale),
        height: Math.round(screenH * scale),
      }

      return {
        framePng: readFileSync(framePath).toString('base64'),
        bezelWidth:  Math.round((compositeW - paddingLeft - paddingRight)  * scale),
        bezelHeight: Math.round((compositeH - paddingTop  - paddingBottom) * scale),
        compositeWidth:  Math.round(expandedW * scale),
        compositeHeight: Math.round(expandedH * scale),
        padding: {
          left:   Math.round(paddingLeft   * scale),
          right:  Math.round(paddingRight  * scale),
          top:    Math.round(paddingTop    * scale),
          bottom: Math.round(paddingBottom * scale),
        },
        screenRect,
        screenCornerRadius: Math.round(screenCornerRadius1x * scale),
        logicalWidth:  screenW,
        logicalHeight: screenH,
        buttons,
      }
    } catch {
      return null
    }
  }
}
