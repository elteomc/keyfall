import { describe, expect, test } from 'vitest'
import type { StoredTransition } from '../src/profile'
import { classifyDigram } from '../src/keyboard'
import { SkillModel } from '../src/skill'
import { typist } from './typist'

describe('the skill model', () => {
  test('an empty profile knows nothing and says so', () => {
    const model = SkillModel.from({})
    expect(model.confident()).toBe(false)
    expect(model.totalHits()).toBe(0)

    const cost = model.cost('packet')
    expect(cost.totalMs).toBe(0)
    expect(cost.novelty).toBe(1)
    expect(cost.weaknesses).toEqual([])
  })

  test('a filled profile is confident and recovers its own class structure', () => {
    const model = SkillModel.from(typist())
    expect(model.confident()).toBe(true)

    // Same-finger is the slowest class for everybody, and the model should have
    // learned that from the data rather than been told it.
    expect(model.classMeanMs('same-finger')).toBeGreaterThan(
      model.classMeanMs('alternating-same-row'),
    )
    expect(model.classMeanMs('same-finger')).toBeGreaterThan(model.globalMeanMs())
  })

  test('an unseen digram falls back on its class, not on the global average', () => {
    const table = typist()
    // `ed` is same-finger. Remove it and the model has to predict it.
    delete table['e d']
    const model = SkillModel.from(table)

    const estimate = model.digram('e', 'd')!
    expect(estimate.hits).toBe(0)
    expect(estimate.kind).toBe('same-finger')
    // Within a millisecond of its class, and nowhere near the global mean.
    expect(estimate.meanMs).toBeCloseTo(model.classMeanMs('same-finger'), 0)
    expect(Math.abs(estimate.meanMs - model.globalMeanMs())).toBeGreaterThan(20)
  })

  test('a thinly sampled digram is pulled toward its class and a well sampled one is not', () => {
    const thin = typist()
    const thick = typist()
    thin['q z'] = { meanMs: 900, samples: 2, errors: 0 }
    thick['q z'] = { meanMs: 900, samples: 400, errors: 0 }

    const thinEstimate = SkillModel.from(thin).digram('q', 'z')!
    const thickEstimate = SkillModel.from(thick).digram('q', 'z')!

    expect(thinEstimate.meanMs).toBeLessThan(400)
    expect(thickEstimate.meanMs).toBeGreaterThan(850)
  })

  /**
   * The property the whole milestone rests on.
   *
   * Two typists are equally slow at `rt` in absolute milliseconds. One of them
   * is slow at everything, so `rt` is not a weakness of theirs, it is just
   * Tuesday. The other is quick everywhere else, so `rt` is a real residual.
   */
  test('weakness is measured against the player, not against the clock', () => {
    const quickTable = typist({ speed: 1, slow: { rt: 2.2 } })
    const slowTable = typist({ speed: 2.2 })

    // Identical raw observations. `rt` takes both typists the same wall time.
    expect(quickTable['r t']!.meanMs).toBeCloseTo(slowTable['r t']!.meanMs, 6)

    const quickRt = SkillModel.from(quickTable).digram('r', 't')!
    const slowRt = SkillModel.from(slowTable).digram('r', 't')!

    expect(quickRt.strain).toBeGreaterThan(2)
    expect(slowRt.strain).toBeCloseTo(1, 1)

    expect(quickRt.weakness).toBe(true)
    expect(slowRt.weakness).toBe(false)
    expect(SkillModel.from(slowTable).weaknesses()).toHaveLength(0)
  })

  /**
   * The other half of the same property.
   *
   * Shrinkage pulls an outlier toward the class it belongs to, so the quick
   * typist's estimate for `rt` comes back *lower* than the slow typist's even
   * though the observation behind it was identical. That is the model saying it
   * does not yet fully believe a value that far from everything else this
   * player does, and it is why strain is read off the raw observation instead.
   */
  test('shrinkage discounts an outlier without hiding it', () => {
    const quick = SkillModel.from(typist({ speed: 1, slow: { rt: 2.2 } }))
    const slow = SkillModel.from(typist({ speed: 2.2 }))

    expect(quick.digram('r', 't')!.meanMs).toBeLessThan(slow.digram('r', 't')!.meanMs)
    expect(quick.digram('r', 't')!.meanMs).toBeGreaterThan(quick.classMeanMs('same-finger'))
  })

  test('a residual needs evidence before it counts', () => {
    const table = typist({ slow: { rt: 2.2 } })
    table['r t'] = { ...(table['r t'] as StoredTransition), samples: 3 }

    const estimate = SkillModel.from(table).digram('r', 't')!
    expect(estimate.strain).toBeGreaterThan(2)
    expect(estimate.weakness).toBe(false)
  })

  test('errors count toward strain as well as time', () => {
    const model = SkillModel.from(typist({ errors: { rt: 0.4 } }))
    const estimate = model.digram('r', 't')!

    expect(estimate.meanMs).toBeCloseTo(model.classMeanMs(estimate.kind), 0)
    expect(estimate.strain).toBeGreaterThan(1.25)
    expect(estimate.weakness).toBe(true)
  })

  test('a word costs more when it is built from the player own weaknesses', () => {
    // `pr` and `ro` both appear in `protocol`.
    const model = SkillModel.from(typist({ slow: { pr: 2.4, ro: 2.4 } }))

    const weak = model.cost('protocol')
    const control = SkillModel.from(typist()).cost('protocol')

    expect(weak.totalMs).toBeGreaterThan(control.totalMs)
    expect(weak.weaknesses).toContain('p r')
    expect(weak.weaknesses).toContain('r o')
    expect(control.weaknesses).toEqual([])
  })

  test('per transition cost separates difficulty from length', () => {
    const model = SkillModel.from(typist())

    const short = model.cost('the')
    const long = model.cost('documentation')

    expect(long.totalMs).toBeGreaterThan(short.totalMs)
    // Neither word is unusual for this typist, so per transition they are close.
    expect(Math.abs(long.perTransitionMs - short.perTransitionMs)).toBeLessThan(40)
  })

  test('weaknesses come back worst first and bounded', () => {
    const model = SkillModel.from(
      typist({ slow: { pr: 3, ro: 2.5, as: 2, io: 1.8, ul: 1.6, nk: 1.5 } }),
    )

    const found = model.weaknesses(3)
    expect(found).toHaveLength(3)
    expect(found[0]!.from + found[0]!.to).toBe('pr')
    expect(found[0]!.strain).toBeGreaterThan(found[2]!.strain)
  })
})

/**
 * The landing key term.
 *
 * Added after the first real profile showed that movement class explained 2.9
 * percent of one player's transition times and the key being reached for
 * explained 25.6. The two are asked as separate questions of the same data
 * rather than combined into one finer bucket, so neither divides the evidence.
 */
describe('the landing key term', () => {
  test('a player with no reach problem is unaffected by it', () => {
    const model = SkillModel.from(typist())

    // Within a tenth of a percent rather than exactly one. The residual is
    // measured against the class mean *after* its own shrinkage toward the
    // global average, so a landing factor absorbs that last sliver of
    // correction. Classes carry thousands of samples, so the sliver is this
    // small.
    for (const key of 'abcdefghijklmnopqrstuvwxyz') {
      expect(Math.abs(model.landingFactor(key) - 1), key).toBeLessThan(0.002)
    }
    expect(model.reaches()).toEqual([])

    // Which means the prediction is the class average, as it was before.
    const predicted = model.expected('a', 'j')!
    const classMean = model.classMeanMs('alternating-same-row')
    expect(Math.abs(predicted - classMean) / classMean).toBeLessThan(0.001)
  })

  test('a slow reach is found and named', () => {
    const model = SkillModel.from(typist({ slowLanding: { t: 1.6 } }))

    expect(model.landingFactor('t')).toBeGreaterThan(1.45)
    expect(model.landingFactor('a')).toBeCloseTo(1, 1)

    const reaches = model.reaches()
    expect(reaches).toHaveLength(1)
    expect(reaches[0]!.key).toBe('t')
  })

  /**
   * The whole reason for the term.
   *
   * A pair the player has never typed is predicted from its class *and* from
   * where it lands, so a slow reach carries over to transitions that have never
   * been observed. Without it the model predicts the class average and is wrong
   * by the entire size of the effect.
   */
  test('an unseen pair landing on a slow key is predicted slow', () => {
    const table = typist({ slowLanding: { t: 1.6 } })
    const truth = table['g t']!.meanMs
    delete table['g t']

    const withTerm = SkillModel.from(table)
    const withoutTerm = SkillModel.from(table, { landingPrior: Infinity })

    expect(withTerm.digram('g', 't')!.hits).toBe(0)
    expect(Math.abs(withTerm.expected('g', 't')! - truth)).toBeLessThan(
      Math.abs(withoutTerm.expected('g', 't')! - truth) / 2,
    )
  })

  /**
   * The two terms must not both claim the same slowness.
   *
   * A whole movement class being slow is the class term's business. Since the
   * landing factor is measured on what the class prediction leaves over, those
   * keys come back at 1.0 rather than inheriting the class effect a second time.
   */
  test('a slow movement class does not leak into the landing factors', () => {
    const slowClass: Record<string, number> = {}
    for (const from of 'abcdefghijklmnopqrstuvwxyz') {
      for (const to of 'abcdefghijklmnopqrstuvwxyz') {
        if (classifyDigram(from, to) === 'same-finger') slowClass[`${from}${to}`] = 2
      }
    }
    const model = SkillModel.from(typist({ slow: slowClass }))

    expect(model.classMeanMs('same-finger')).toBeGreaterThan(
      model.classMeanMs('alternating-same-row') * 1.5,
    )
    for (const key of 'abcdefghijklmnopqrstuvwxyz') {
      expect(model.landingFactor(key), key).toBeCloseTo(1, 1)
    }
  })

  test('a reach needs evidence before it is named', () => {
    const table = typist({ slowLanding: { t: 1.6 }, samples: 1 })
    const model = SkillModel.from(table)

    expect(model.landingHits('t')).toBeLessThan(40)
    expect(model.reaches()).toEqual([])
  })

  test('one extreme pair cannot carry a landing key on its own', () => {
    const table = typist()
    table['q z'] = { meanMs: 6000, samples: 400, errors: 0 }

    // Clamped, so the worst a single pair can do is pull toward 2.5x its class.
    expect(SkillModel.from(table).landingFactor('z')).toBeLessThan(1.6)
  })

  /**
   * Strain deliberately keeps the class baseline rather than the full
   * prediction.
   *
   * Folding the landing term in would mark a slow `t` as explained, and the
   * pairs that reach it would stop being weaknesses. That is the most trainable
   * thing in a profile, and hiding it behind the machinery built to find it
   * would be the wrong kind of consistency.
   */
  test('a slow reach still surfaces as a weakness', () => {
    const model = SkillModel.from(typist({ slowLanding: { t: 1.6 } }))

    const pairs = model.weaknesses(12)
    expect(pairs.length).toBeGreaterThan(3)
    expect(pairs.every((p) => p.to === 't')).toBe(true)
    expect(model.cost('start').weaknesses.length).toBeGreaterThan(0)
  })
})
