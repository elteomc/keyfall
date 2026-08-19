import { describe, expect, test } from 'vitest'
import { Effects } from '../src/game/effects'
import type { Feedback, FeedbackKind } from '../src/game/session'

function event(kind: FeedbackKind, tier: Feedback['tier'] = 'flat'): Feedback {
  return { kind, x: 400, y: 300, progress: 0.5, tier }
}

/** Runs the system forward in 16 ms frames, as the game loop does. */
function advance(effects: Effects, totalMs: number): void {
  for (let left = totalMs; left > 0; left -= 16) effects.update(Math.min(16, left))
}

describe('Effects', () => {
  test('a hit throws sparks, and they die on their own', () => {
    const effects = new Effects()
    expect(effects.particleCount()).toBe(0)

    effects.push(event('hit'))
    expect(effects.particleCount()).toBeGreaterThan(0)

    advance(effects, 2000)
    expect(effects.particleCount()).toBe(0)
  })

  test('intensity grows with the combo tier', () => {
    const flat = new Effects()
    const peak = new Effects()

    flat.push(event('hit', 'flat'))
    peak.push(event('hit', 'peak'))

    expect(peak.particleCount()).toBeGreaterThan(flat.particleCount())
  })

  test('a breach shoves the arena and a hit does not', () => {
    const quiet = new Effects()
    quiet.push(event('hit'))
    quiet.update(16)
    expect(quiet.shakeOffset()).toEqual({ x: 0, y: 0 })

    const shoved = new Effects()
    shoved.push(event('breach'))
    shoved.update(16)
    const offset = shoved.shakeOffset()
    expect(Math.abs(offset.x) + Math.abs(offset.y)).toBeGreaterThan(0)

    // And it settles quickly, because a lingering wobble reads as lag.
    advance(shoved, 600)
    expect(shoved.shakeOffset()).toEqual({ x: 0, y: 0 })
  })

  test('reduced motion drops the shake and thins the debris', () => {
    const calm = new Effects({ reducedMotion: true })
    const full = new Effects()

    calm.push(event('breach'))
    full.push(event('breach'))
    calm.update(16)
    full.update(16)

    expect(calm.shakeOffset()).toEqual({ x: 0, y: 0 })
    expect(calm.particleCount()).toBeGreaterThan(0)
    expect(calm.particleCount()).toBeLessThan(full.particleCount())
  })

  test('a long peak-tier run cannot outgrow the particle ceiling', () => {
    const effects = new Effects({ maxParticles: 40 })
    for (let i = 0; i < 200; i++) effects.push(event('kill', 'peak'))
    expect(effects.particleCount()).toBe(40)
  })

  test('clearing drops everything a finished run left behind', () => {
    const effects = new Effects()
    effects.push(event('breach'))
    effects.update(16)

    effects.clear()
    expect(effects.particleCount()).toBe(0)
    expect(effects.shakeOffset()).toEqual({ x: 0, y: 0 })
  })
})
