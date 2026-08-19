import { describe, expect, test } from 'vitest'
import type { EnemyKind } from '../src/game/session'
import {
  comboMultiplier,
  difficultyMultiplier,
  qualityMultiplier,
  wordScore,
} from '../src/game/scoring'

const KINDS: readonly EnemyKind[] = ['drone', 'swarm', 'tank', 'sprinter', 'shield']

/** A middling word typed adequately, as a baseline to vary one channel from. */
const AVERAGE = {
  chars: 6,
  kind: 'drone' as EnemyKind,
  intensity: 0.5,
  comboFraction: 0.5,
  accuracy: 0.9,
  rhythm: 0.8,
}

describe('word scoring', () => {
  test('every channel raises the score', () => {
    const base = wordScore(AVERAGE)
    expect(wordScore({ ...AVERAGE, chars: 12 })).toBeGreaterThan(base)
    expect(wordScore({ ...AVERAGE, kind: 'shield' })).toBeGreaterThan(base)
    expect(wordScore({ ...AVERAGE, intensity: 1 })).toBeGreaterThan(base)
    expect(wordScore({ ...AVERAGE, comboFraction: 1 })).toBeGreaterThan(base)
    expect(wordScore({ ...AVERAGE, accuracy: 1 })).toBeGreaterThan(base)
    expect(wordScore({ ...AVERAGE, rhythm: 1 })).toBeGreaterThan(base)
  })

  test('a destroyed enemy always pays, and a word with no characters does not', () => {
    const worst = wordScore({
      chars: 3,
      kind: 'drone',
      intensity: 0,
      comboFraction: 0,
      accuracy: 0,
      rhythm: 0,
    })
    expect(worst).toBeGreaterThan(0)
    expect(Number.isInteger(worst)).toBe(true)

    expect(wordScore({ ...AVERAGE, chars: 0 })).toBe(0)
  })

  test('nonsense inputs are clamped rather than propagated', () => {
    const absurd = wordScore({
      ...AVERAGE,
      intensity: 12,
      comboFraction: 9,
      accuracy: 4,
      rhythm: 3,
    })
    const best = wordScore({
      ...AVERAGE,
      intensity: 1,
      comboFraction: 1,
      accuracy: 1,
      rhythm: 1,
    })

    expect(absurd).toBe(best)
    expect(wordScore({ ...AVERAGE, accuracy: -1 })).toBe(wordScore({ ...AVERAGE, accuracy: 0 }))
  })

  /**
   * The rule from section 11: the leaderboard strategy must not collapse into
   * "pick the enemy with the fattest multiplier". These two tests are the
   * reason the multipliers are bounded at all, so they are written against the
   * bounds rather than against any single pair of numbers.
   */
  test('typing well swings the score far wider than choosing targets', () => {
    const easiest = Math.min(...KINDS.map((kind) => difficultyMultiplier(kind, 0)))
    const hardest = Math.max(...KINDS.map((kind) => difficultyMultiplier(kind, 1)))
    const targetChoice = hardest / easiest

    const typingWell =
      (qualityMultiplier(1, 1) * comboMultiplier(1)) /
      (qualityMultiplier(0, 0) * comboMultiplier(0))

    expect(targetChoice).toBeLessThan(1.75)
    expect(typingWell).toBeGreaterThan(3 * targetChoice)
  })

  test('the plainest enemy typed cleanly beats the fanciest enemy typed badly', () => {
    const clean = wordScore({
      chars: 6,
      kind: 'drone',
      intensity: 0,
      comboFraction: 1,
      accuracy: 1,
      rhythm: 1,
    })
    const chased = wordScore({
      chars: 6,
      kind: 'shield',
      intensity: 1,
      comboFraction: 0,
      accuracy: 0.5,
      rhythm: 0.4,
    })

    expect(clean).toBeGreaterThan(chased)
  })
})
