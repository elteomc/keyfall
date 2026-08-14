import { describe, expect, test } from 'vitest'
import {
  distinguishingPrefix,
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

  test('a wrong character reports what was expected and keeps the lock', () => {
    expect(resolveLockedKey('run', 1, 'x')).toEqual({ kind: 'wrong', expected: 'u', typed: 1 })
  })

  test('the reset policy sends the player back to the start of the sequence', () => {
    expect(resolveLockedKey('shield', 4, 'x', 'reset')).toEqual({
      kind: 'wrong',
      expected: 'l',
      typed: 0,
    })
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
