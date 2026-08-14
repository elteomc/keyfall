import { describe, expect, test } from 'vitest'
import { ComboTracker, comboGain, type WordOutcome } from '../src/combo'
import { rhythmScore } from '../src/metrics'

/**
 * Combo is fed by completed words, so the fixtures are words rather than raw
 * keystrokes. Rhythm comes from the real metric instead of a hand-picked
 * number, so these tests break if the two ever drift apart.
 */
function word(
  chars: number,
  intervalMs: number,
  correctKeys = chars,
  totalKeys = chars,
): WordOutcome {
  const intervals = Array.from({ length: chars - 1 }, () => intervalMs)
  return {
    chars,
    durationMs: intervalMs * (chars - 1),
    correctKeys,
    totalKeys,
    rhythm: rhythmScore(intervals),
  }
}

describe('comboGain', () => {
  test('perfect typing gains exactly one', () => {
    expect(comboGain({ accuracy: 1, speedRatio: 1, rhythm: 1 })).toBeCloseTo(1, 10)
  })

  test('accuracy is weighted above speed, and speed above rhythm', () => {
    const lostAccuracy = comboGain({ accuracy: 0.8, speedRatio: 1, rhythm: 1 })
    const lostSpeed = comboGain({ accuracy: 1, speedRatio: 0.8, rhythm: 1 })
    const lostRhythm = comboGain({ accuracy: 1, speedRatio: 1, rhythm: 0.8 })

    expect(lostAccuracy).toBeLessThan(lostSpeed)
    expect(lostSpeed).toBeLessThan(lostRhythm)
  })

  test('every channel is monotone', () => {
    const base = { accuracy: 0.9, speedRatio: 1, rhythm: 0.8 }
    expect(comboGain({ ...base, accuracy: 1 })).toBeGreaterThan(comboGain(base))
    expect(comboGain({ ...base, speedRatio: 1.2 })).toBeGreaterThan(comboGain(base))
    expect(comboGain({ ...base, rhythm: 1 })).toBeGreaterThan(comboGain(base))
  })

  test('the speed ratio is clamped at both ends', () => {
    const absurd = comboGain({ accuracy: 1, speedRatio: 50, rhythm: 1 })
    expect(absurd).toBe(comboGain({ accuracy: 1, speedRatio: 1.6, rhythm: 1 }))
    expect(absurd).toBeCloseTo(1.6, 10)

    expect(comboGain({ accuracy: 1, speedRatio: 0, rhythm: 1 })).toBeCloseTo(0.5, 10)
  })
})

describe('ComboTracker', () => {
  test('a fresh tracker has no combo', () => {
    const combo = new ComboTracker()
    expect(combo.value()).toBe(0)
    expect(combo.tier()).toBe('flat')
    expect(combo.lastGain()).toBe(0)
  })

  test('clean words build the combo and lift the tier', () => {
    const combo = new ComboTracker()

    combo.completeWord(word(7, 100))
    expect(combo.value()).toBeGreaterThan(0)
    expect(combo.tier()).toBe('flat')

    for (let i = 0; i < 19; i++) combo.completeWord(word(7, 100))
    expect(combo.value()).toBeGreaterThan(20)
    expect(combo.tier()).toBe('peak')
  })

  test('the combo is capped', () => {
    const combo = new ComboTracker({ maxValue: 5 })
    for (let i = 0; i < 10; i++) combo.completeWord(word(7, 100))
    expect(combo.value()).toBe(5)
  })

  test('an error cuts the combo immediately', () => {
    const combo = new ComboTracker()
    for (let i = 0; i < 6; i++) combo.completeWord(word(7, 100))

    const built = combo.value()
    expect(built).toBeGreaterThan(0)

    // Half the combo survives one mistake, rather than none of it.
    combo.registerError()
    expect(combo.value()).toBeCloseTo(built / 2, 10)
  })

  test('an error also slows the next few words, through recent accuracy', () => {
    const clean = new ComboTracker()
    const shaky = new ComboTracker()

    for (let i = 0; i < 4; i++) {
      clean.completeWord(word(7, 100))
      shaky.completeWord(word(7, 100, 7, 9))
    }

    expect(shaky.lastGain()).toBeLessThan(clean.lastGain())
    expect(shaky.value()).toBeLessThan(clean.value())
  })

  test('the window rolls, so old words stop counting', () => {
    const combo = new ComboTracker({ windowWords: 4 })

    for (let i = 0; i < 4; i++) combo.completeWord(word(7, 100, 7, 14))
    const sloppy = combo.lastGain()

    for (let i = 0; i < 4; i++) combo.completeWord(word(7, 100))
    expect(combo.lastGain()).toBeGreaterThan(sloppy * 2)
  })

  test('speed is judged against the player, not against an absolute', () => {
    // Two typists a factor of four apart, each typing evenly and without a
    // mistake, and each starting from a baseline that is two thirds of their
    // own true speed. They should end up earning the same combo.
    const slow = new ComboTracker({ initialBaselineCpm: 150 })
    const fast = new ComboTracker({ initialBaselineCpm: 600 })

    for (let i = 0; i < 30; i++) {
      slow.completeWord(word(7, 240))
      fast.completeWord(word(7, 60))
    }

    expect(slow.lastGain()).toBeCloseTo(fast.lastGain(), 6)
    // Both baselines have caught up, so neither gain is merely sitting on the
    // clamp, which would make the comparison meaningless.
    expect(slow.lastGain()).toBeLessThan(1.6)
    expect(slow.baselineCpm()).toBeGreaterThan(150)
  })

  test('a tier is not given up on the first small dip', () => {
    const combo = new ComboTracker({ tierThresholds: [10, 20, 30], errorRetention: 0.85 })
    while (combo.value() < 10) combo.completeWord(word(7, 100))
    expect(combo.tier()).toBe('warm')

    combo.registerError()
    expect(combo.value()).toBeLessThan(10)
    expect(combo.tier()).toBe('warm')

    combo.registerError()
    combo.registerError()
    expect(combo.tier()).toBe('flat')
  })

  test('a word too short to time still counts and cannot divide by zero', () => {
    const combo = new ComboTracker({ initialBaselineCpm: 300 })
    const gain = combo.completeWord({
      chars: 1,
      durationMs: 0,
      correctKeys: 1,
      totalKeys: 1,
      rhythm: null,
    })

    expect(Number.isFinite(gain)).toBe(true)
    expect(gain).toBeGreaterThan(0)
    // An unmeasurable word must not move the speed baseline either.
    expect(combo.baselineCpm()).toBe(300)
  })
})
