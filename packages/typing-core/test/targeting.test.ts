import { describe, expect, test } from 'vitest'
import {
  distinguishingPrefix,
  errorSeverity,
  resolveLockedKey,
  resolveUnlockedKey,
} from '../src/targeting'

const candidates = [
  { id: 'a', sequence: 'algorithm' },
  { id: 'b', sequence: 'alignment' },
  { id: 'c', sequence: 'vector' },
]

describe('resolveUnlockedKey', () => {
  test('a unique first character locks immediately', () => {
    const result = resolveUnlockedKey(candidates, '', 'v')
    expect(result).toEqual({ kind: 'lock', targetId: 'c', typed: 1, prefix: 'v' })
  })

  test('a shared prefix stays ambiguous until it resolves', () => {
    const first = resolveUnlockedKey(candidates, '', 'a')
    expect(first).toEqual({ kind: 'ambiguous', prefix: 'a', candidateIds: ['a', 'b'] })

    const second = resolveUnlockedKey(candidates, 'a', 'l')
    expect(second.kind).toBe('ambiguous')

    const third = resolveUnlockedKey(candidates, 'al', 'g')
    expect(third).toEqual({ kind: 'lock', targetId: 'a', typed: 3, prefix: 'alg' })
  })

  test('a fully typed word wins over a longer word with the same prefix', () => {
    const overlapping = [
      { id: 'short', sequence: 'run' },
      { id: 'long', sequence: 'runtime' },
    ]
    expect(resolveUnlockedKey(overlapping, 'ru', 'n')).toEqual({
      kind: 'lock',
      targetId: 'short',
      typed: 3,
      prefix: 'run',
    })
  })

  test('an unmatched character resets the prefix', () => {
    expect(resolveUnlockedKey(candidates, 'al', 'z')).toEqual({ kind: 'miss', prefix: '' })
    expect(resolveUnlockedKey(candidates, '', 'q')).toEqual({ kind: 'miss', prefix: '' })
  })
})

describe('resolveLockedKey', () => {
  test('correct characters advance and finally complete', () => {
    expect(resolveLockedKey('run', 0, 'r')).toEqual({ kind: 'hit', typed: 1, complete: false })
    expect(resolveLockedKey('run', 2, 'n')).toEqual({ kind: 'hit', typed: 3, complete: true })
  })

  test('a wrong character never advances the word', () => {
    expect(resolveLockedKey('run', 1, 'x')).toEqual({
      kind: 'wrong',
      expected: 'u',
      typed: 1,
      complete: false,
    })
  })

  test('typing rubbish can never destroy a word', () => {
    // The property an earlier version threw away by advancing on any key: six
    // wrong letters finished a six-letter word, which made accuracy pointless.
    let typed = 0
    for (const key of 'xxxxxx') {
      const result = resolveLockedKey('packet', typed, key, 'hold', true)
      expect(result.kind).toBe('wrong')
      expect(result.complete).toBe(false)
      typed = result.typed
    }
    expect(typed).toBe(0)
  })

  test('recovery: the player retypes the character they fumbled', () => {
    // Cursor at 3 on "packet", expecting 'k'. They notice and hit 'k'.
    expect(resolveLockedKey('packet', 3, 'k', 'hold', true)).toEqual({
      kind: 'hit',
      typed: 4,
      complete: false,
    })
  })

  test('recovery: the player carries on with the next character', () => {
    // Cursor at 3 expecting 'k'. They do not notice and send 'e', the letter
    // after it, so the fumbled 'k' is skipped and the word carries on.
    expect(resolveLockedKey('packet', 3, 'e', 'hold', true)).toEqual({
      kind: 'hit',
      typed: 5,
      complete: false,
    })
  })

  test('skipping ahead is only offered while recovering', () => {
    // The same key, with no slip behind it, is simply wrong. Otherwise a player
    // could skip characters at will.
    expect(resolveLockedKey('packet', 3, 'e', 'hold', false).kind).toBe('wrong')
  })

  test('the reset policy sends the player back to the start of the sequence', () => {
    expect(resolveLockedKey('shield', 4, 'x', 'reset')).toEqual({
      kind: 'wrong',
      expected: 'l',
      typed: 0,
      complete: false,
    })
  })

  test('severity scales with how much of the word a mistake spoiled', () => {
    expect(errorSeverity(6, 0)).toBe(1)
    expect(errorSeverity(6, 5)).toBeCloseTo(1 / 6, 5)
    expect(errorSeverity(6, 0)).toBeGreaterThan(errorSeverity(6, 3))
    expect(errorSeverity(6, 3)).toBeGreaterThan(errorSeverity(6, 5))
  })

  test('the policy only applies to mistakes, never to correct keys', () => {
    expect(resolveLockedKey('shield', 4, 'l', 'reset')).toEqual({
      kind: 'hit',
      typed: 5,
      complete: false,
    })
  })
})

describe('distinguishingPrefix', () => {
  test('reports the shortest prefix that identifies a target', () => {
    expect(distinguishingPrefix(candidates, 'c')).toBe('v')
    expect(distinguishingPrefix(candidates, 'a')).toBe('alg')
    expect(distinguishingPrefix(candidates, 'missing')).toBeNull()
  })
})
