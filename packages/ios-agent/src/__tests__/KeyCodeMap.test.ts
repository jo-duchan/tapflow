import { describe, it, expect } from 'vitest'
import { KEY_CODE_MAP, MODIFIER_BITS } from '../KeyCodeMap'

describe('KEY_CODE_MAP', () => {
  describe('알파벳 키 매핑', () => {
    const letters: [string, number][] = [
      ['KeyA', 0x04], ['KeyB', 0x05], ['KeyC', 0x06], ['KeyD', 0x07], ['KeyE', 0x08],
      ['KeyF', 0x09], ['KeyG', 0x0A], ['KeyH', 0x0B], ['KeyI', 0x0C], ['KeyJ', 0x0D],
      ['KeyK', 0x0E], ['KeyL', 0x0F], ['KeyM', 0x10], ['KeyN', 0x11], ['KeyO', 0x12],
      ['KeyP', 0x13], ['KeyQ', 0x14], ['KeyR', 0x15], ['KeyS', 0x16], ['KeyT', 0x17],
      ['KeyU', 0x18], ['KeyV', 0x19], ['KeyW', 0x1A], ['KeyX', 0x1B], ['KeyY', 0x1C],
      ['KeyZ', 0x1D],
    ]
    it.each(letters)('%s → 0x%s', (code, expected) => {
      expect(KEY_CODE_MAP[code]).toBe(expected)
    })
  })

  describe('숫자 키 매핑', () => {
    const digits: [string, number][] = [
      ['Digit1', 0x1E], ['Digit2', 0x1F], ['Digit3', 0x20], ['Digit4', 0x21],
      ['Digit5', 0x22], ['Digit6', 0x23], ['Digit7', 0x24], ['Digit8', 0x25],
      ['Digit9', 0x26], ['Digit0', 0x27],
    ]
    it.each(digits)('%s → 0x%s', (code, expected) => {
      expect(KEY_CODE_MAP[code]).toBe(expected)
    })
  })

  describe('제어 키 매핑', () => {
    it('Enter → 0x28', () => expect(KEY_CODE_MAP['Enter']).toBe(0x28))
    it('Escape → 0x29', () => expect(KEY_CODE_MAP['Escape']).toBe(0x29))
    it('Backspace → 0x2A', () => expect(KEY_CODE_MAP['Backspace']).toBe(0x2A))
    it('Tab → 0x2B', () => expect(KEY_CODE_MAP['Tab']).toBe(0x2B))
    it('Space → 0x2C', () => expect(KEY_CODE_MAP['Space']).toBe(0x2C))
    it('Delete → 0x4C', () => expect(KEY_CODE_MAP['Delete']).toBe(0x4C))
    it('CapsLock → 0x39', () => expect(KEY_CODE_MAP['CapsLock']).toBe(0x39))
  })

  describe('방향키 매핑', () => {
    it('ArrowRight → 0x4F', () => expect(KEY_CODE_MAP['ArrowRight']).toBe(0x4F))
    it('ArrowLeft → 0x50', () => expect(KEY_CODE_MAP['ArrowLeft']).toBe(0x50))
    it('ArrowDown → 0x51', () => expect(KEY_CODE_MAP['ArrowDown']).toBe(0x51))
    it('ArrowUp → 0x52', () => expect(KEY_CODE_MAP['ArrowUp']).toBe(0x52))
  })

  describe('기능 키 매핑', () => {
    it('F1 → 0x3A', () => expect(KEY_CODE_MAP['F1']).toBe(0x3A))
    it('F12 → 0x45', () => expect(KEY_CODE_MAP['F12']).toBe(0x45))
  })

  describe('IME / 언어 전환 키', () => {
    it('Lang1 (한/영) → 0x90', () => expect(KEY_CODE_MAP['Lang1']).toBe(0x90))
    it('Lang2 (한자) → 0x91', () => expect(KEY_CODE_MAP['Lang2']).toBe(0x91))
  })

  describe('수정자 키가 KEY_CODE_MAP에 포함됨', () => {
    const modifierKeys = [
      'ControlLeft', 'ShiftLeft', 'AltLeft', 'MetaLeft',
      'ControlRight', 'ShiftRight', 'AltRight', 'MetaRight',
    ]
    it.each(modifierKeys)('%s 가 KEY_CODE_MAP에 정의됨', (key) => {
      expect(KEY_CODE_MAP[key]).toBeDefined()
    })
  })

  describe('미정의 키', () => {
    it('알 수 없는 코드는 undefined 반환', () => {
      expect(KEY_CODE_MAP['UnknownKey']).toBeUndefined()
      expect(KEY_CODE_MAP['GamepadA']).toBeUndefined()
      expect(KEY_CODE_MAP['']).toBeUndefined()
    })
  })

  describe('HID Usage ID 유효 범위', () => {
    it('모든 값이 0x04~0xFF 범위', () => {
      for (const [key, value] of Object.entries(KEY_CODE_MAP)) {
        expect(value, `${key} HID usage out of range`).toBeGreaterThanOrEqual(0x04)
        expect(value, `${key} HID usage out of range`).toBeLessThanOrEqual(0xFF)
      }
    })
  })

  describe('HID Usage ID 중복 없음', () => {
    it('동일한 HID 코드가 두 키에 할당되지 않음', () => {
      const seen = new Map<number, string>()
      for (const [key, value] of Object.entries(KEY_CODE_MAP)) {
        if (seen.has(value)) {
          throw new Error(`HID 0x${value.toString(16)} 중복: ${seen.get(value)} vs ${key}`)
        }
        seen.set(value, key)
      }
    })
  })
})

describe('MODIFIER_BITS', () => {
  describe('수정자 비트 값', () => {
    it('ControlLeft → 0x01 (bit 0)', () => expect(MODIFIER_BITS['ControlLeft']).toBe(0x01))
    it('ShiftLeft → 0x02 (bit 1)', () => expect(MODIFIER_BITS['ShiftLeft']).toBe(0x02))
    it('AltLeft → 0x04 (bit 2)', () => expect(MODIFIER_BITS['AltLeft']).toBe(0x04))
    it('MetaLeft → 0x08 (bit 3)', () => expect(MODIFIER_BITS['MetaLeft']).toBe(0x08))
    it('ControlRight → 0x10 (bit 4)', () => expect(MODIFIER_BITS['ControlRight']).toBe(0x10))
    it('ShiftRight → 0x20 (bit 5)', () => expect(MODIFIER_BITS['ShiftRight']).toBe(0x20))
    it('AltRight → 0x40 (bit 6)', () => expect(MODIFIER_BITS['AltRight']).toBe(0x40))
    it('MetaRight → 0x80 (bit 7)', () => expect(MODIFIER_BITS['MetaRight']).toBe(0x80))
  })

  describe('비트 중복 없음 (OR 조합 가능)', () => {
    it('모든 비트가 서로 다름', () => {
      const values = Object.values(MODIFIER_BITS)
      const unique = new Set(values)
      expect(unique.size).toBe(values.length)
    })

    it('각 비트가 정확히 2의 거듭제곱', () => {
      for (const [key, bit] of Object.entries(MODIFIER_BITS)) {
        expect(bit & (bit - 1), `${key} bit is not power of 2`).toBe(0)
      }
    })

    it('모든 비트를 OR하면 0xFF', () => {
      const combined = Object.values(MODIFIER_BITS).reduce((acc, bit) => acc | bit, 0)
      expect(combined).toBe(0xFF)
    })
  })

  describe('수정자 비트 조합 시뮬레이션', () => {
    it('Ctrl+Shift 조합 = 0x03', () => {
      const mask = MODIFIER_BITS['ControlLeft']! | MODIFIER_BITS['ShiftLeft']!
      expect(mask).toBe(0x03)
    })

    it('Ctrl+Alt+Shift 조합 = 0x07', () => {
      const mask =
        MODIFIER_BITS['ControlLeft']! |
        MODIFIER_BITS['AltLeft']! |
        MODIFIER_BITS['ShiftLeft']!
      expect(mask).toBe(0x07)
    })
  })
})
