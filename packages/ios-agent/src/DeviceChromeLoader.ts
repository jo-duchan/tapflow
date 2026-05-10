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
  onTop: boolean                            // true = button is above device frame (e.g. home button)
  normalOffset: { x: number; y: number }   // button center in expanded composite 2× px (retracted/default)
  rolloverOffset: { x: number; y: number } // button center at rollover (extended/hover) position
  buttonW: number                           // button width in 2× composite px
  buttonH: number                           // button height in 2× composite px
  usagePage: number                         // HID usage page for SimulatorKit injection (0 = unknown)
  usage: number                             // HID usage code (0 = unknown)
  buttonPng?: string                        // base64 PNG of button at 2× (for CSS-animated overlay)
  pressedPng?: string                       // base64 PNG of pressed state (imageDown asset)
  pressedRect?: ChromeRect                  // position + size in expanded composite 2× px
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
  imageDown?: string        // pressed state PDF name (without .pdf)
  imageDownDrawMode?: string
  onTop?: boolean
  usagePage?: number        // HID usage page for SimulatorKit button injection
  usage?: number            // HID usage code
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

interface PressedData {
  pdfPath: string
  topLeftX: number  // 1× pts, same coordinate space as ButtonDrawData
  topLeftY: number
  pdfW: number      // 1× pts (natural PDF size)
  pdfH: number
}

interface ButtonLayout {
  margins: { left: number; top: number; right: number; bottom: number }
  drawData: ButtonDrawData[]
  buttons: ChromeButton[]
  pressedData: (PressedData | null)[]  // parallel to buttons[]
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
  const pressedData: (PressedData | null)[] = []

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

    const btnTopLeftX = centerX - w / 2
    // 'top' anchor: roll.y is center Y (button protrudes above device top); convert to top-left.
    // Other anchors: roll.y is already the top-left Y.
    const btnTopLeftY = (inp.anchor === 'top') ? topY - h / 2 : topY
    drawData.push({
      pdfPath:  join(resourcesDir, `${inp.image}.pdf`),
      topLeftX: btnTopLeftX,
      topLeftY: btnTopLeftY,
      onTop:    inp.onTop ?? false,
    })

    // imageDown: pressed state PDF at the same position as the normal button
    let pressed: PressedData | null = null
    if (inp.imageDown) {
      const downPath = join(resourcesDir, `${inp.imageDown}.pdf`)
      if (existsSync(downPath)) {
        try {
          const downSize = getSipsSize(downPath)
          pressed = {
            pdfPath:  downPath,
            topLeftX: btnTopLeftX,
            topLeftY: btnTopLeftY,
            pdfW:     downSize.width,
            pdfH:     downSize.height,
          }
        } catch { /* skip unmeasurable pressed asset */ }
      }
    }
    pressedData.push(pressed)

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
      case 'top': {
        // 'top' anchor: ny is center Y; convert to top-edge for normalOffset (same convention as left/right).
        // nx must be align-aware (trailing = right edge of device body).
        const align = inp.align ?? 'leading'
        normalCX = align === 'center'   ? mL + compositeW / 2 + nx
                 : align === 'trailing' ? mL + compositeW + nx
                 :                        mL + nx
        normalCY = mT + ny - h / 2
        break
      }
      default: // left / fallback — y is top edge
        normalCX = mL + nx
        normalCY = mT + ny
    }

    buttons.push({
      name: inp.name,
      accessibilityTitle: inp.accessibilityTitle ?? inp.name,
      anchor: inp.anchor ?? 'left',
      onTop: inp.onTop ?? false,
      normalOffset: {
        x: Math.round(normalCX * scale),
        y: Math.round(normalCY * scale),
      },
      // rolloverOffset.x = centerX (from roll offsets).
      // rolloverOffset.y: for top anchor, rollover extends the button further above the frame,
      //   so store the rollover top-edge Y (= btnTopLeftY) not the normal top-edge Y.
      //   For left/right/bottom anchors Y is the same at normal and rollover positions.
      rolloverOffset: {
        x: Math.round(centerX * scale),
        y: Math.round(((inp.anchor === 'top') ? btnTopLeftY : normalCY) * scale),
      },
      buttonW: Math.round(w * scale),
      buttonH: Math.round(h * scale),
      usagePage: inp.usagePage ?? 0,
      usage: inp.usage ?? 0,
    })
  }

  return { margins, drawData, buttons, pressedData }
}

// ---------------------------------------------------------------------------
// Single PDF → PNG at 2× (used for pressed-state button images)
// ---------------------------------------------------------------------------

function renderPdfToPng(pdfPath: string, outPath: string): void {
  const SCRIPT = `
import Foundation
import CoreGraphics
import ImageIO

let src = CommandLine.arguments[1]
let dst = CommandLine.arguments[2]
let scale: CGFloat = 2

guard let doc = CGPDFDocument(URL(fileURLWithPath: src) as CFURL),
      let page = doc.page(at: 1) else { exit(1) }

let box = page.getBoxRect(.mediaBox)
let w = max(1, Int(ceil(box.width  * scale)))
let h = max(1, Int(ceil(box.height * scale)))

let ctx = CGContext(
  data: nil, width: w, height: h,
  bitsPerComponent: 8, bytesPerRow: 0,
  space: CGColorSpaceCreateDeviceRGB(),
  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue).rawValue
)!
ctx.scaleBy(x: scale, y: scale)
ctx.drawPDFPage(page)

let img  = ctx.makeImage()!
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: dst) as CFURL, "public.png" as CFString, 1, nil)!
CGImageDestinationAddImage(dest, img, nil)
CGImageDestinationFinalize(dest)
`
  const scriptPath = join(tmpdir(), 'tapflow-pdf-to-png.swift')
  writeFileSync(scriptPath, SCRIPT)
  execFileSync('swift', [scriptPath, pdfPath, outPath])
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
  leftWidth: number, rightWidth: number,
  topHeight: number, bottomHeight: number,
  cornerW: number, cornerH: number,
  screenW: number, screenH: number,
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

// Device body dims (bezel + screen hole) in 1× pts
let leftW:   CGFloat = ${leftWidth}
let rightW:  CGFloat = ${rightWidth}
let topH:    CGFloat = ${topHeight}
let botH:    CGFloat = ${bottomHeight}
let cornerW: CGFloat = ${cornerW}
let cornerH: CGFloat = ${cornerH}
let screenW: CGFloat = ${screenW}
let screenH: CGFloat = ${screenH}
let mL: CGFloat = ${margins.left}
let mT: CGFloat = ${margins.top}
let mR: CGFloat = ${margins.right}
let mB: CGFloat = ${margins.bottom}
let scale: CGFloat = 2
let dst = CommandLine.arguments[1]

// Device body (bezel + screen area)
let bodyW = leftW + screenW + rightW   // = leftWidth + screenW + rightWidth
let bodyH = topH  + screenH + botH

// Middle section (area between corners, where edge strips stretch)
let midW = bodyW - cornerW * 2
let midH = bodyH - cornerH * 2

// Total canvas including button margins
let canW = Int((mL + bodyW + mR) * scale)
let canH = Int((mT + bodyH + mB) * scale)

let ctx = CGContext(
  data: nil, width: canW, height: canH,
  bitsPerComponent: 8, bytesPerRow: 0,
  space: CGColorSpaceCreateDeviceRGB(),
  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue).rawValue
)!

// Rasterize PDF to CGImage at 2×.
// drawPDFPage cannot non-uniformly scale PDF pages; rasterize first, then ctx.draw() stretches.
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

// Draw bitmap at (tlX, tlY) in 1× top-left pts, stretched to (w, h).
func drawImg(_ img: CGImage, tlX: CGFloat, tlY: CGFloat, w: CGFloat, h: CGFloat) {
  ctx.draw(img, in: CGRect(
    x: tlX * scale,
    y: CGFloat(canH) - (tlY + h) * scale,
    width:  w * scale,
    height: h * scale
  ))
}

// Draw PDF at (tlX, tlY) in 1× pts — used for buttons (no stretching needed).
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

let imgTL = rasterize(${JSON.stringify(slicePaths.topLeft)})
let imgT  = rasterize(${JSON.stringify(slicePaths.top)})
let imgTR = rasterize(${JSON.stringify(slicePaths.topRight)})
let imgR  = rasterize(${JSON.stringify(slicePaths.right)})
let imgBR = rasterize(${JSON.stringify(slicePaths.bottomRight)})
let imgB  = rasterize(${JSON.stringify(slicePaths.bottom)})
let imgBL = rasterize(${JSON.stringify(slicePaths.bottomLeft)})
let imgL  = rasterize(${JSON.stringify(slicePaths.left)})

let behindBtns: [(path: String, x: CGFloat, y: CGFloat)] = [
  ${behind.map(btnLiteral).join(',\n  ')}
]
let onTopBtns: [(path: String, x: CGFloat, y: CGFloat)] = [
  ${onTop.map(btnLiteral).join(',\n  ')}
]

for btn in behindBtns { drawPDF(btn.path, tlX: btn.x, tlY: btn.y) }

// Device body starts at (mL, mT) in expanded canvas.
// Corners are at natural size; edge strips are stretched to fill the gap between corners.
// Screen hole (mL+leftW, mT+topH, screenW, screenH) is left transparent.
let bx = mL; let by = mT

// Top row
if let img = imgTL { drawImg(img, tlX: bx,                 tlY: by,                w: cornerW, h: cornerH) }
if let img = imgT  { drawImg(img, tlX: bx + cornerW,       tlY: by,                w: midW,    h: cornerH) }
if let img = imgTR { drawImg(img, tlX: bx + bodyW - cornerW, tlY: by,              w: cornerW, h: cornerH) }

// Middle row — corners overlap the screen area but their inner zone is transparent
if let img = imgL  { drawImg(img, tlX: bx,                 tlY: by + cornerH,      w: cornerW, h: midH) }
if let img = imgR  { drawImg(img, tlX: bx + bodyW - cornerW, tlY: by + cornerH,    w: cornerW, h: midH) }

// Bottom row
if let img = imgBL { drawImg(img, tlX: bx,                 tlY: by + bodyH - cornerH, w: cornerW, h: cornerH) }
if let img = imgB  { drawImg(img, tlX: bx + cornerW,       tlY: by + bodyH - cornerH, w: midW,    h: cornerH) }
if let img = imgBR { drawImg(img, tlX: bx + bodyW - cornerW, tlY: by + bodyH - cornerH, w: cornerW, h: cornerH) }

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
// Button PNG attachment — renders each button's normal PDF separately for CSS overlay
// ---------------------------------------------------------------------------

function attachButtonPngs(
  buttons: ChromeButton[],
  drawData: ButtonDrawData[],
  chromeName: string,
): void {
  for (let i = 0; i < buttons.length; i++) {
    if (i >= drawData.length) continue
    const pdfPath = drawData[i].pdfPath
    const cacheKey = `tapflow-btn-normal-${chromeName}-${i}.png`
    const outPath = join(tmpdir(), cacheKey)
    try {
      if (!existsSync(outPath) || statSync(pdfPath).mtimeMs > statSync(outPath).mtimeMs) {
        renderPdfToPng(pdfPath, outPath)
      }
      buttons[i].buttonPng = readFileSync(outPath).toString('base64')
    } catch { /* skip if rendering fails */ }
  }
}

// ---------------------------------------------------------------------------
// Pressed PNG attachment — renders imageDown PDFs and attaches to buttons[]
// ---------------------------------------------------------------------------

function attachPressedPngs(
  buttons: ChromeButton[],
  pressedData: (PressedData | null)[],
  chromeName: string,
  scale: number,
): void {
  for (let i = 0; i < buttons.length; i++) {
    const pd = pressedData[i]
    if (!pd) continue

    const cacheKey = `tapflow-btn-pressed-${chromeName}-${i}.png`
    const outPath  = join(tmpdir(), cacheKey)

    try {
      if (!existsSync(outPath) || statSync(pd.pdfPath).mtimeMs > statSync(outPath).mtimeMs) {
        renderPdfToPng(pd.pdfPath, outPath)
      }
      buttons[i].pressedPng  = readFileSync(outPath).toString('base64')
      buttons[i].pressedRect = {
        x:      Math.round(pd.topLeftX * scale),
        y:      Math.round(pd.topLeftY * scale),
        width:  Math.round(pd.pdfW    * scale),
        height: Math.round(pd.pdfH    * scale),
      }
    } catch { /* skip if rendering fails */ }
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

        const { margins: btnM, drawData, buttons, pressedData } = computeButtonLayout(
          rawInputs, resourcesDir, pdfSize.width, pdfSize.height, scale,
        )

        const expandedW = pdfSize.width  + btnM.left + btnM.right
        const expandedH = pdfSize.height + btnM.top  + btnM.bottom

        // v3: buttons excluded from framePng — rendered separately as CSS-animated overlays
        const framePath = join(tmpdir(), `tapflow-frame-v3-${chromeName}.png`)
        if (!existsSync(framePath) || statSync(compositePdf).mtimeMs > statSync(framePath).mtimeMs) {
          renderFramePng(compositePdf, framePath, btnM, [])
        }

        attachButtonPngs(buttons, drawData, chromeName)
        attachPressedPngs(buttons, pressedData, chromeName, scale)

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

      // Device body = bezel insets + screen (baguette: canvasSize = insets + innerSize)
      const compositeW = leftWidth  + screenW + rightWidth
      const compositeH = topHeight  + screenH + bottomHeight

      const bezelInset        = Math.max(leftWidth, topHeight)
      const screenCornerRadius1x = Math.max(0, outerRadius - bezelInset)

      const { margins: btnM, drawData, buttons, pressedData } = computeButtonLayout(
        rawInputs, resourcesDir, compositeW, compositeH, scale,
      )

      const expandedW = compositeW + btnM.left + btnM.right
      const expandedH = compositeH + btnM.top  + btnM.bottom

      // nb = no-buttons: buttons excluded from framePng, rendered separately as CSS-animated overlays
      const framePath = join(tmpdir(), `tapflow-frame-nineslice-nb-${chromeName}-${screenW}x${screenH}-c${Math.round(expandedW)}x${Math.round(expandedH)}.png`)
      const needsRender = !existsSync(framePath)
        || statSync(slicePaths.topLeft).mtimeMs > statSync(framePath).mtimeMs

      if (needsRender) {
        renderNineSlicePng(
          slicePaths, framePath,
          leftWidth, rightWidth, topHeight, bottomHeight,
          cornerW, cornerH, screenW, screenH,
          btnM, [],
        )
      }

      attachButtonPngs(buttons, drawData, chromeName)
      attachPressedPngs(buttons, pressedData, chromeName, scale)

      // Screen hole: starts at sizing insets within the device body
      const screenRect: ChromeRect = {
        x:      Math.round((btnM.left + leftWidth)  * scale),
        y:      Math.round((btnM.top  + topHeight)  * scale),
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
