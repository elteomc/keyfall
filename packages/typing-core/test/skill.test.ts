import { describe, expect, test } from 'vitest'
import type { StoredTransition } from '../src/profile'
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
