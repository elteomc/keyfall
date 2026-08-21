import { describe, expect, test } from 'vitest'
import { DIGRAM_CLASSES, classifyDigram, keyDistance, keyPosition } from '../src/keyboard'

describe('keyboard geometry', () => {
  test('every lowercase letter is on the layout exactly once', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 26; i++) {
      const char = String.fromCharCode(97 + i)
      const position = keyPosition(char)
      expect(position, char).not.toBeNull()
      expect(position!.finger).toBeGreaterThanOrEqual(1)
      expect(position!.finger).toBeLessThanOrEqual(8)
      seen.add(char)
    }
    expect(seen.size).toBe(26)
  })

  test('anything off the layout classifies as nothing rather than as something', () => {
    expect(keyPosition('1')).toBeNull()
    expect(keyPosition(' ')).toBeNull()
    expect(classifyDigram('a', '.')).toBeNull()
    expect(classifyDigram('!', 'a')).toBeNull()
    expect(keyDistance('a', '?')).toBeNull()
  })

  test('a repeated character is its own class', () => {
    expect(classifyDigram('s', 's')).toBe('repeat')
    expect(classifyDigram('e', 'e')).toBe('repeat')
  })

  test('two different letters on one finger are same-finger', () => {
    // Both on the left middle finger, which is the movement everyone is slow at.
    expect(classifyDigram('e', 'd')).toBe('same-finger')
    expect(classifyDigram('c', 'e')).toBe('same-finger')
  })

  test('hands and rows decide the rest', () => {
    // s and d are left ring and left middle, both home row.
    expect(classifyDigram('s', 'd')).toBe('same-hand-same-row')
    // q is left pinky top, f is left index home.
    expect(classifyDigram('q', 'f')).toBe('same-hand-row-change')
    // a is left home, j is right home.
    expect(classifyDigram('a', 'j')).toBe('alternating-same-row')
    // a is left home, u is right top.
    expect(classifyDigram('a', 'u')).toBe('alternating-row-change')
  })

  test('every class is reachable from the lowercase alphabet', () => {
    const found = new Set<string>()
    for (let i = 0; i < 26; i++) {
      for (let j = 0; j < 26; j++) {
        const kind = classifyDigram(String.fromCharCode(97 + i), String.fromCharCode(97 + j))
        if (kind) found.add(kind)
      }
    }
    expect([...found].sort()).toEqual([...DIGRAM_CLASSES].sort())
  })

  test('distance grows with reach', () => {
    const near = keyDistance('f', 'g')!
    const far = keyDistance('q', 'p')!
    expect(near).toBeLessThan(far)
    expect(keyDistance('f', 'f')).toBe(0)
  })
})
