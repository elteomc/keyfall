import { describe, expect, test } from 'vitest'
import {
  type Profile,
  type RunContribution,
  type RunRecord,
  type TransitionStat,
  MAX_RECENT_RUNS,
  beatenBests,
  emptyProfile,
  exportProfile,
  importProfile,
  lifetimeAccuracy,
  recordRun,
} from '../src/index'

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-1',
    startedAtMs: 1000,
    durationMs: 60_000,
    outcome: 'cleared',
    score: 100,
    kills: 20,
    wpm: 60,
    accuracy: 0.95,
    peakBurstWpm: 90,
    rhythm: 0.8,
    acquisitionMs: 400,
    ...overrides,
  }
}

function stat(from: string, to: string, meanMs: number, samples: number, errors = 0): TransitionStat {
  return { from, to, meanMs, shrunkMeanMs: meanMs, samples, errors, errorRate: errors / samples }
}

function contribution(overrides: Partial<RunContribution> = {}): RunContribution {
  return {
    record: record(),
    totalKeys: 100,
    correctKeys: 95,
    words: [],
    transitions: [],
    ...overrides,
  }
}

function fold(profile: Profile, runs: RunContribution[]): Profile {
  return runs.reduce((acc, run, i) => recordRun(acc, run, 2000 + i), profile)
}

describe('profile', () => {
  test('a fresh profile claims nothing', () => {
    const profile = emptyProfile(500)
    expect(profile.aggregate.runs).toBe(0)
    expect(profile.bests.score).toBe(0)
    expect(lifetimeAccuracy(profile)).toBe(1)
  })

  test('recordRun does not mutate the profile it was given', () => {
    const before = emptyProfile(0)
    const after = recordRun(before, contribution(), 1)

    expect(before.aggregate.runs).toBe(0)
    expect(after.aggregate.runs).toBe(1)
    expect(after.recentRuns).toHaveLength(1)
  })

  test('the first run sets the estimate rather than being dragged toward zero', () => {
    const profile = recordRun(emptyProfile(0), contribution(), 1)
    // An unweighted first run, or the estimate would read 12 wpm for a 60 wpm run.
    expect(profile.aggregate.typicalWpm).toBe(60)
    expect(profile.aggregate.typicalAccuracy).toBeCloseTo(0.95, 5)
  })

  test('later runs move the estimate without replacing it', () => {
    const first = recordRun(emptyProfile(0), contribution(), 1)
    const second = recordRun(first, contribution({ record: record({ wpm: 100 }) }), 2)

    expect(second.aggregate.typicalWpm).toBeGreaterThan(60)
    expect(second.aggregate.typicalWpm).toBeLessThan(100)
  })

  test('lifetime accuracy counts keys, not runs', () => {
    const profile = fold(emptyProfile(0), [
      contribution({ totalKeys: 100, correctKeys: 100 }),
      contribution({ totalKeys: 900, correctKeys: 450 }),
    ])

    // A long sloppy run outweighs a short clean one, which a mean of the two
    // run accuracies would have hidden.
    expect(lifetimeAccuracy(profile)).toBeCloseTo(0.55, 5)
  })

  test('bests only ever climb', () => {
    const profile = fold(emptyProfile(0), [
      contribution({ record: record({ score: 500, kills: 40 }) }),
      contribution({ record: record({ score: 100, kills: 5 }) }),
    ])

    expect(profile.bests.score).toBe(500)
    expect(profile.bests.kills).toBe(40)
  })

  test('beatenBests names what a run beat, read before the fold', () => {
    const profile = recordRun(emptyProfile(0), contribution(), 1)

    expect(beatenBests(profile.bests, record({ score: 200 }))).toEqual(['score'])
    expect(beatenBests(profile.bests, record({ score: 1 }))).toEqual([])
    expect(beatenBests(profile.bests, record({ score: 200, wpm: 70 })).sort()).toEqual([
      'score',
      'wpm',
    ])
  })

  test('recent runs are capped and newest first', () => {
    const runs = Array.from({ length: MAX_RECENT_RUNS + 5 }, (_, i) =>
      contribution({ record: record({ runId: `run-${i}`, score: i }) }),
    )
    const profile = fold(emptyProfile(0), runs)

    expect(profile.recentRuns).toHaveLength(MAX_RECENT_RUNS)
    expect(profile.recentRuns[0]?.runId).toBe(`run-${MAX_RECENT_RUNS + 4}`)
    // The aggregate still remembers every run, which is the point of keeping both.
    expect(profile.aggregate.runs).toBe(MAX_RECENT_RUNS + 5)
  })

  test('corpus exposure counts repeats', () => {
    const profile = fold(emptyProfile(0), [
      contribution({ words: ['vector', 'kernel'] }),
      contribution({ words: ['vector'] }),
    ])

    expect(profile.corpusExposure['vector']).toBe(2)
    expect(profile.corpusExposure['kernel']).toBe(1)
  })

  describe('transition merging', () => {
    test('a thin run cannot move an estimate built from many samples', () => {
      const established = recordRun(
        emptyProfile(0),
        contribution({ transitions: [stat('p', 'h', 100, 300)] }),
        1,
      )
      const merged = recordRun(
        established,
        contribution({ transitions: [stat('p', 'h', 900, 3)] }),
        2,
      )

      const cell = merged.transitions['p h']
      expect(cell?.samples).toBe(303)
      // Weighted by sample count, so 3 slow observations move it by under 10 ms.
      expect(cell?.meanMs).toBeGreaterThan(100)
      expect(cell?.meanMs).toBeLessThan(110)
    })

    test('errors accumulate alongside timings', () => {
      const profile = fold(emptyProfile(0), [
        contribution({ transitions: [stat('t', 'r', 120, 10, 2)] }),
        contribution({ transitions: [stat('t', 'r', 120, 10, 3)] }),
      ])

      expect(profile.transitions['t r']?.errors).toBe(5)
      expect(profile.transitions['t r']?.samples).toBe(20)
    })
  })

  describe('export and import', () => {
    test('a profile survives a round trip', () => {
      const profile = fold(emptyProfile(0), [
        contribution({ words: ['vector'], transitions: [stat('p', 'h', 150, 12)] }),
      ])

      expect(importProfile(exportProfile(profile))).toEqual(profile)
    })

    test('junk is rejected rather than repaired', () => {
      expect(importProfile('not json at all')).toBeNull()
      expect(importProfile('{}')).toBeNull()
      expect(importProfile('[]')).toBeNull()
      expect(importProfile('null')).toBeNull()
    })

    test('a profile from a future version is rejected', () => {
      const profile = emptyProfile(0)
      const future = JSON.stringify({ ...profile, version: profile.version + 1 })
      expect(importProfile(future)).toBeNull()
    })

    test('a truncated profile is rejected', () => {
      const profile = emptyProfile(0)
      const broken = JSON.stringify({ ...profile, aggregate: { runs: 3 } })
      expect(importProfile(broken)).toBeNull()
    })
  })
})
