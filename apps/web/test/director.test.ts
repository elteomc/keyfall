import { describe, expect, test } from 'vitest'
import { Director, type DirectorSignals } from '../src/game/director'

const CALM: DirectorSignals = { enemies: 0, nearestProgress: 0, livesLost: 0 }
const CROWDED: DirectorSignals = { enemies: 9, nearestProgress: 0.95, livesLost: 0 }
/** Reads inside the target band, where the director is meant to do nothing. */
const STEADY: DirectorSignals = { enemies: 3, nearestProgress: 0.5, livesLost: 0 }

/** Feeds the director a signal for a stretch of time in 16 ms frames. */
function hold(director: Director, ms: number, signals: DirectorSignals): void {
  for (let left = ms; left > 0; left -= 16) director.update(Math.min(16, left), signals)
}

describe('Director', () => {
  test('a run opens at the bottom of the dial', () => {
    expect(new Director().level()).toBe(0)
  })

  test('nothing moves while pressure sits inside the band', () => {
    const director = new Director()
    hold(director, 4000, CALM)
    const settled = director.level()
    expect(settled).toBeGreaterThan(0)

    hold(director, 30000, STEADY)
    expect(director.level()).toBe(settled)
  })

  test('good play is not answered immediately', () => {
    const director = new Director()

    // Well inside the lag window, the dial has not moved at all.
    hold(director, 2000, CALM)
    expect(director.level()).toBe(0)

    hold(director, 2000, CALM)
    expect(director.level()).toBeGreaterThan(0)
  })

  test('the dial cannot turn faster than its cap', () => {
    const director = new Director()
    hold(director, 12000, CALM)

    // Around 9.5 seconds past the lag, at the rise cap of 0.01 per second.
    expect(director.level()).toBeLessThanOrEqual(0.1)
    expect(director.level()).toBeGreaterThan(0.07)
  })

  test('relief comes faster than escalation', () => {
    const rising = new Director()
    hold(rising, 12500, CALM)
    const climbed = rising.level()

    const falling = new Director()
    hold(falling, 25000, CALM)
    const high = falling.level()
    hold(falling, 12500, CROWDED)
    const dropped = high - falling.level()

    expect(dropped).toBeGreaterThan(climbed)
  })

  test('a breach relieves pressure without waiting out the lag', () => {
    const director = new Director()
    hold(director, 20000, CALM)
    const before = director.level()

    director.update(16, { enemies: 4, nearestProgress: 0.4, livesLost: 1 })
    expect(director.level()).toBeLessThan(before)
  })

  test('the dial never leaves [0, 1]', () => {
    const floor = new Director()
    hold(floor, 60000, CROWDED)
    expect(floor.level()).toBe(0)

    const ceiling = new Director()
    hold(ceiling, 300000, CALM)
    expect(ceiling.level()).toBe(1)
  })

  test('archetypes unlock as the dial climbs, and drones never vanish', () => {
    const director = new Director()
    expect(Object.keys(director.plan().weights)).toEqual(['drone'])

    hold(director, 300000, CALM)
    const weights = director.plan().weights
    expect(Object.keys(weights).sort()).toEqual(['drone', 'shield', 'sprinter', 'swarm', 'tank'])
    expect(weights.drone).toBeGreaterThan(0)
  })

  test('spawns come faster and enemies fall faster as the dial climbs', () => {
    const director = new Director()
    const calm = director.plan()

    hold(director, 300000, CALM)
    const hard = director.plan()

    expect(hard.intervalMs).toBeLessThan(calm.intervalMs)
    expect(hard.speedScale).toBeGreaterThan(calm.speedScale)
  })
})
