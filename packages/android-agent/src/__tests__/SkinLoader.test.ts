import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}))

import { existsSync, readFileSync } from 'fs'
import { loadSkin, parseLayout } from '../SkinLoader.js'

const mockExists = vi.mocked(existsSync)
const mockRead = vi.mocked(readFileSync)

// ── Layout fixtures ──────────────────────────────────────────────────────────

const PIXEL_9_LAYOUT = `
parts {
  device {
    display {
      width 1080
      height 2424
      x 0
      y 0
      corner_radius 87
    }
  }
  portrait {
    background {
      image back.webp
    }
    foreground {
      mask mask.webp
      cutout hole
    }
  }
}
layouts {
  portrait {
    width 1198
    height 2531
    event EV_SW:0:1
    part1 {
      name portrait
      x 0
      y 0
    }
    part2 {
      name device
      x 55
      y 58
    }
  }
}
`

const GALAXY_NEXUS_LAYOUT = `
parts {
  device {
    display {
      width 720
      height 1280
      x 0
      y 0
    }
  }
  portrait {
    background {
      image port_back.webp
    }
    onion {
      image port_fore.webp
    }
  }
}
layouts {
  portrait {
    width 1101
    height 1709
    event EV_SW:0:1
    part1 {
      name portrait
      x 0
      y 0
    }
    part2 {
      name device
      x 192
      y 213
    }
  }
}
`

const PIXEL_9_CONFIG = `skin.name=pixel_9\nskin.path=/mock/sdk/skins/pixel_9\nhw.lcd.width=1080\nhw.lcd.height=2424\n`
const NO_SKIN_CONFIG = `skin.name=_no_skin\nskin.path=_no_skin\n`
const DUMMY_WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46]) // "RIFF" — placeholder bytes

// ── parseLayout ──────────────────────────────────────────────────────────────

describe('parseLayout', () => {
  it('parses pixel_9 layout (modern format with corner_radius)', () => {
    const result = parseLayout(PIXEL_9_LAYOUT)
    expect(result).toEqual({
      backgroundImage: 'back.webp',
      displayWidth: 1080,
      displayHeight: 2424,
      cornerRadius: 87,
      compositeWidth: 1198,
      compositeHeight: 2531,
      screenX: 55,
      screenY: 58,
    })
  })

  it('parses galaxy_nexus layout (legacy format, non-zero screen offset, no corner_radius)', () => {
    const result = parseLayout(GALAXY_NEXUS_LAYOUT)
    expect(result).toEqual({
      backgroundImage: 'port_back.webp',
      displayWidth: 720,
      displayHeight: 1280,
      cornerRadius: 0,
      compositeWidth: 1101,
      compositeHeight: 1709,
      screenX: 192,
      screenY: 213,
    })
  })

  it('finds device part regardless of part key name (not hardcoded to part2)', () => {
    const layout = `
parts {
  device {
    display {
      width 1080
      height 2424
      x 0
      y 0
      corner_radius 87
    }
  }
  portrait {
    background {
      image back.webp
    }
  }
}
layouts {
  portrait {
    width 1198
    height 2531
    part99 {
      name device
      x 55
      y 58
    }
  }
}
`
    const result = parseLayout(layout)
    expect(result?.screenX).toBe(55)
    expect(result?.screenY).toBe(58)
  })

  it('returns null when display width is missing', () => {
    const broken = PIXEL_9_LAYOUT.replace('width 1080', '')
    expect(parseLayout(broken)).toBeNull()
  })

  it('returns null when background image is missing', () => {
    const broken = PIXEL_9_LAYOUT.replace('image back.webp', '')
    expect(parseLayout(broken)).toBeNull()
  })

  it('returns null when layouts section is absent', () => {
    const broken = PIXEL_9_LAYOUT.replace(/layouts \{[\s\S]*\}/, '')
    expect(parseLayout(broken)).toBeNull()
  })
})

// ── loadSkin ─────────────────────────────────────────────────────────────────

describe('loadSkin', () => {
  beforeEach(() => {
    mockExists.mockReturnValue(true)
    mockRead.mockImplementation((path: unknown) => {
      const p = String(path)
      if (p.endsWith('config.ini')) return PIXEL_9_CONFIG
      if (p.endsWith('layout')) return PIXEL_9_LAYOUT
      return DUMMY_WEBP
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns SkinData with correct fields for a valid skin', () => {
    const skin = loadSkin('Pixel_9', '/mock/avd')
    expect(skin).not.toBeNull()
    expect(skin?.screenRect).toEqual({ x: 55, y: 58, width: 1080, height: 2424 })
    expect(skin?.compositeSize).toEqual({ width: 1198, height: 2531 })
    expect(skin?.cornerRadius).toBe(87)
    expect(skin?.backPng).toBe(DUMMY_WEBP.toString('base64'))
  })

  it('returns null for skin.name=_no_skin', () => {
    mockRead.mockReturnValue(NO_SKIN_CONFIG)
    expect(loadSkin('NoSkinAvd', '/mock/avd')).toBeNull()
  })

  it('returns null when config.ini does not exist', () => {
    mockExists.mockReturnValue(false)
    expect(loadSkin('Pixel_9', '/mock/avd')).toBeNull()
  })

  it('returns null when layout file does not exist', () => {
    mockExists.mockImplementation((p: unknown) => !String(p).endsWith('layout'))
    expect(loadSkin('Pixel_9', '/mock/avd')).toBeNull()
  })

  it('returns null when background image file does not exist', () => {
    mockExists.mockImplementation((p: unknown) => !String(p).endsWith('.webp'))
    expect(loadSkin('Pixel_9', '/mock/avd')).toBeNull()
  })

  it('returns null and does not throw when readFileSync throws', () => {
    mockRead.mockImplementation(() => { throw new Error('permission denied') })
    expect(() => loadSkin('Pixel_9', '/mock/avd')).not.toThrow()
    expect(loadSkin('Pixel_9', '/mock/avd')).toBeNull()
  })
})
