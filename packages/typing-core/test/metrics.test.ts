import { describe, expect, test } from 'vitest'
import {
  accuracy,
  coefficientOfVariation,
  interKeyIntervals,
  rhythmScore,
  wordsPerMinute,
} from '../src/metrics'

describe('interval helpers', () => {
  test('intervals are differences between consecutive timestamps', () => {
    expect(interKeyIntervals([100, 180, 300])).toEqual([80, 120])
    expect(interKeyIntervals([100])).toEqual([])
  })

  test('the coefficient of variation is scale free', () => {
    const slow = coefficientOfVariation([200, 400, 600])!
    const fast = coefficientOfVariation([100, 200, 300])!
    expect(slow).toBeCloseTo(fast, 10)
  })
})

describe('rhythmScore', () => {
  test('perfectly even typing scores 1', () => {
    expect(rhythmScore([90, 90, 90, 90])).toBeCloseTo(1, 10)
  })

  test('uneven typing scores lower than even typing', () => {
    const even = rhythmScore([90, 92, 88, 91])!
    const uneven = rhythmScore([40, 220, 60, 300])!
    expect(uneven).toBeLessThan(even)
  })

  test('short samples do not produce a score', () => {
    expect(rhythmScore([90, 90])).toBeNull()
    expect(rhythmScore([90, 5000])).toBeNull()
  })

  test('an interruption is dropped instead of being charged to rhythm', () => {
    expect(rhythmScore([90, 90, 5000, 90])).toBeCloseTo(1, 10)
  })
})

describe('summary metrics', () => {
  test('wpm uses the five character convention', () => {
    expect(wordsPerMinute(500, 60000)).toBeCloseTo(100, 10)
    expect(wordsPerMinute(10, 0)).toBe(0)
  })

  test('accuracy defaults to 1 before any keystroke', () => {
    expect(accuracy(0, 0)).toBe(1)
    expect(accuracy(9, 10)).toBeCloseTo(0.9, 10)
  })
})
