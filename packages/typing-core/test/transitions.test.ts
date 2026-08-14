import { describe, expect, test } from 'vitest'
import { TransitionTable } from '../src/transitions'

describe('TransitionTable', () => {
  test('the first observation seeds the mean exactly', () => {
    const table = new TransitionTable()
    table.observe('t', 'h', 90, true)

    const th = table.stats()[0]!
    expect(th.meanMs).toBe(90)
    expect(th.samples).toBe(1)
    expect(table.globalMean()).toBe(90)
  })

  test('each observation moves the mean by exactly eta', () => {
    const table = new TransitionTable({ eta: 0.2 })
    table.observe('a', 'b', 100, true)
    table.observe('a', 'b', 200, true)

    // 0.8 * 100 + 0.2 * 200
    expect(table.stats()[0]!.meanMs).toBeCloseTo(120, 10)
  })

  test('the mean converges on a changed typing speed', () => {
    const table = new TransitionTable({ eta: 0.3 })
    table.observe('t', 'h', 300, true)
    for (let i = 0; i < 40; i++) table.observe('t', 'h', 60, true)

    expect(table.stats()[0]!.meanMs).toBeCloseTo(60, 1)
  })

  test('recent observations outweigh old ones', () => {
    const fast = new TransitionTable({ eta: 0.5 })
    const slow = new TransitionTable({ eta: 0.05 })
    for (const table of [fast, slow]) {
      table.observe('a', 'b', 200, true)
      table.observe('a', 'b', 100, true)
    }

    expect(fast.stats()[0]!.meanMs).toBeLessThan(slow.stats()[0]!.meanMs)
  })

  test('sparse estimates are pulled toward the global mean', () => {
    const table = new TransitionTable()
    for (let i = 0; i < 40; i++) table.observe('t', 'h', 60, true)
    table.observe('p', 'r', 400, true)

    const pr = table.stats().find((s) => s.from === 'p' && s.to === 'r')!
    expect(pr.meanMs).toBe(400)
    expect(pr.shrunkMeanMs).toBeLessThan(pr.meanMs)
    expect(pr.shrunkMeanMs).toBeGreaterThan(table.globalMean())
  })

  test('shrinkage fades as samples accumulate', () => {
    const table = new TransitionTable({ shrinkage: 6 })
    for (let i = 0; i < 40; i++) table.observe('t', 'h', 60, true)

    table.observe('p', 'r', 400, true)
    const sparse = table.stats().find((s) => s.from === 'p' && s.to === 'r')!.shrunkMeanMs

    for (let i = 0; i < 30; i++) table.observe('p', 'r', 400, true)
    const settled = table.stats().find((s) => s.from === 'p' && s.to === 'r')!.shrunkMeanMs

    // The estimate walks back toward what was actually measured as evidence
    // accumulates, rather than staying anchored to the prior.
    expect(settled).toBeGreaterThan(sparse)
    expect(400 - settled).toBeLessThan((400 - sparse) / 3)
  })

  test('errors are counted without polluting the timing estimate', () => {
    const table = new TransitionTable()
    table.observe('a', 'b', 100, true)
    table.observe('a', 'b', 0, false)

    const ab = table.stats()[0]!
    expect(ab.meanMs).toBe(100)
    expect(ab.errors).toBe(1)
    expect(ab.errorRate).toBeCloseTo(0.5, 10)
    expect(table.globalMean()).toBe(100)
  })

  test('slowest ignores transitions without enough samples', () => {
    const table = new TransitionTable()
    for (let i = 0; i < 10; i++) table.observe('t', 'h', 60, true)
    for (let i = 0; i < 10; i++) table.observe('p', 'r', 180, true)
    table.observe('z', 'q', 900, true)

    const slowest = table.slowest(5, 4)
    expect(slowest.map((s) => `${s.from}${s.to}`)).toEqual(['pr', 'th'])
  })

  test('slowest respects its own limit', () => {
    const table = new TransitionTable()
    for (const pair of ['ab', 'cd', 'ef', 'gh']) {
      for (let i = 0; i < 5; i++) table.observe(pair[0]!, pair[1]!, 100, true)
    }

    expect(table.slowest(2, 4)).toHaveLength(2)
  })

  test('an empty table reports nothing', () => {
    const table = new TransitionTable()
    expect(table.stats()).toEqual([])
    expect(table.slowest(5)).toEqual([])
    expect(table.globalMean()).toBe(0)
  })
})
