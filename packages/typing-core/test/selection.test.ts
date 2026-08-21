import { describe, expect, test } from 'vitest'
import { type Bucket, EMPTY_HISTORY, buildPool, selectCandidate } from '../src/selection'
import { SkillModel } from '../src/skill'
import { typist } from './typist'

/** A deterministic stand-in for the game's seeded generator. */
function sequence(values: readonly number[]): () => number {
  let i = 0
  return () => values[i++ % values.length] as number
}

function counter(seed = 1): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

const WORDS = [
  'protocol', 'pattern', 'packet', 'process', 'promise', 'problem',
  'session', 'segment', 'service', 'setting', 'storage', 'summary',
  'measure', 'monitor', 'mapping', 'machine', 'message', 'minimum',
  'balance', 'binding', 'builder', 'boolean', 'boundary', 'browser',
]

/**
 * Exposure counts standing in for a played-in profile.
 *
 * A real player has met some words far more often than others, and that spread
 * is what the exploration bucket is reading. A pool where every word is equally
 * familiar has nothing to explore by definition, so building one here would be
 * testing a case the game does not produce.
 */
const EXPOSURE: Record<string, number> = Object.fromEntries(
  WORDS.map((word, i) => [word, (i * 7) % 23]),
)

function poolFor(slow: Record<string, number> = {}) {
  const model = SkillModel.from(typist({ slow }))
  return buildPool(WORDS, model, EXPOSURE)
}

function tally(pool: readonly { bucket: Bucket }[]): Record<Bucket, number> {
  const counts: Record<Bucket, number> = { comfort: 0, frontier: 0, weakness: 0, exploration: 0 }
  for (const c of pool) counts[c.bucket] += 1
  return counts
}

describe('building a candidate pool', () => {
  test('an unconfident model files everything as exploration', () => {
    const pool = buildPool(WORDS, SkillModel.from({}), {})
    expect(pool).toHaveLength(WORDS.length)
    expect(pool.every((c) => c.bucket === 'exploration')).toBe(true)
  })

  test('a confident model fills every bucket', () => {
    const counts = tally(poolFor({ pr: 2.4, ro: 2.2, ss: 2.4 }))
    for (const bucket of ['comfort', 'frontier', 'weakness', 'exploration'] as const) {
      expect(counts[bucket], bucket).toBeGreaterThan(0)
    }
  })

  test('quantiles rank the pool and span it', () => {
    const pool = poolFor()
    const quantiles = pool.map((c) => c.quantile).sort((a, b) => a - b)
    expect(quantiles[0]).toBe(0)
    expect(quantiles[quantiles.length - 1]).toBe(1)

    const hardest = [...pool].sort((a, b) => b.quantile - a.quantile)[0]!
    const easiest = [...pool].sort((a, b) => a.quantile - b.quantile)[0]!
    expect(hardest.cost.perTransitionMs).toBeGreaterThan(easiest.cost.perTransitionMs)
  })

  test('a word is only in the weakness bucket when it carries one', () => {
    const pool = poolFor({ pr: 2.6, ro: 2.6 })
    for (const candidate of pool) {
      if (candidate.bucket === 'weakness') expect(candidate.cost.weaknesses.length).toBeGreaterThan(0)
    }
    const weakWords = pool.filter((c) => c.bucket === 'weakness').map((c) => c.word)
    expect(weakWords).toContain('protocol')
  })

  test('exposure makes a familiar word less novel than an unseen one', () => {
    const model = SkillModel.from(typist())
    const seen = buildPool(WORDS, model, { ...EXPOSURE, protocol: 400 })
    const unseen = buildPool(WORDS, model, EXPOSURE)

    const find = (pool: typeof seen, word: string) => pool.find((c) => c.word === word)!
    expect(find(seen, 'protocol').novelty).toBeLessThan(find(unseen, 'protocol').novelty)
  })
})

describe('selecting a candidate', () => {
  test('a draw comes from the bucket that was asked for', () => {
    const pool = poolFor({ pr: 2.6, ro: 2.6 })
    for (const bucket of ['comfort', 'frontier', 'weakness', 'exploration'] as const) {
      const selection = selectCandidate(pool, bucket, EMPTY_HISTORY, counter(3))
      expect(selection, bucket).not.toBeNull()
      expect(selection!.bucket).toBe(bucket)
      expect(selection!.requested).toBe(bucket)
    }
  })

  test('an excluded word is never served', () => {
    const pool = poolFor()
    const excluded = new Set(WORDS.slice(0, WORDS.length - 1))
    const random = counter(9)

    for (let i = 0; i < 50; i++) {
      const selection = selectCandidate(pool, 'frontier', { ...EMPTY_HISTORY, excluded }, random)
      expect(selection!.candidate.word).toBe(WORDS[WORDS.length - 1])
    }
  })

  test('every candidate excluded returns nothing rather than a duplicate', () => {
    const pool = poolFor()
    const excluded = new Set(WORDS)
    expect(selectCandidate(pool, 'frontier', { ...EMPTY_HISTORY, excluded }, counter(2))).toBeNull()
  })

  test('an empty bucket falls back and says which bucket it used', () => {
    // No weakness anywhere in the pool, so the weakness bucket does not exist.
    const pool = poolFor()
    expect(pool.some((c) => c.bucket === 'weakness')).toBe(false)

    const selection = selectCandidate(pool, 'weakness', EMPTY_HISTORY, counter(5))
    expect(selection).not.toBeNull()
    expect(selection!.requested).toBe('weakness')
    expect(selection!.bucket).not.toBe('weakness')
  })

  test('the frontier aims near the middle of the pool rather than at its top', () => {
    const pool = poolFor()
    const random = counter(17)
    const drawn: number[] = []
    for (let i = 0; i < 400; i++) {
      drawn.push(selectCandidate(pool, 'frontier', EMPTY_HISTORY, random)!.candidate.quantile)
    }
    const mean = drawn.reduce((a, b) => a + b, 0) / drawn.length
    expect(mean).toBeGreaterThan(0.55)
    expect(mean).toBeLessThan(0.85)
  })

  /**
   * Measured against the same draw without the penalty, not against a rate.
   *
   * A bucket in a pool this size holds only a handful of words, so some repeats
   * inside a window of six are unavoidable and a fixed threshold would be
   * testing the pool size rather than the penalty. The controlled comparison
   * says the thing worth saying.
   */
  test('a word served recently is pushed to the back of the queue', () => {
    const pool = poolFor()

    const repeatRate = (usePenalty: boolean): number => {
      const random = counter(23)
      let repeats = 0
      let recent: string[] = []
      for (let i = 0; i < 400; i++) {
        const history = usePenalty ? { ...EMPTY_HISTORY, recentWords: recent } : EMPTY_HISTORY
        const word = selectCandidate(pool, 'frontier', history, random)!.candidate.word
        if (recent.includes(word)) repeats += 1
        recent = [word, ...recent].slice(0, 6)
      }
      return repeats / 400
    }

    expect(repeatRate(true)).toBeLessThan(repeatRate(false) * 0.5)
  })

  test('a weakness already trained recently gives way to another one', () => {
    const pool = poolFor({ pr: 2.6, ro: 2.6, ss: 2.6, tt: 2.6, nn: 2.6 })
    const random = counter(31)

    const withoutHistory = new Set<string>()
    const withHistory = new Set<string>()
    for (let i = 0; i < 120; i++) {
      withoutHistory.add(selectCandidate(pool, 'weakness', EMPTY_HISTORY, random)!.candidate.word)
      withHistory.add(
        selectCandidate(
          pool,
          'weakness',
          { ...EMPTY_HISTORY, recentDigrams: ['p r', 'r o'] },
          random,
        )!.candidate.word,
      )
    }

    const prWords = (words: Set<string>) => [...words].filter((w) => w.includes('pr')).length
    expect(prWords(withHistory)).toBeLessThanOrEqual(prWords(withoutHistory))
  })

  test('the best fitting candidate is the likeliest and never the only one', () => {
    const pool = poolFor()
    // A generator that always returns zero takes the top of every shortlist.
    const first = selectCandidate(pool, 'frontier', EMPTY_HISTORY, sequence([0]))!.candidate.word

    const seen = new Set<string>()
    const random = counter(41)
    for (let i = 0; i < 200; i++) {
      seen.add(selectCandidate(pool, 'frontier', EMPTY_HISTORY, random)!.candidate.word)
    }

    expect(seen.size).toBeGreaterThan(4)
    expect(seen).toContain(first)
  })
})
