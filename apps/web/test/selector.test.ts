import { describe, expect, test } from 'vitest'
import { emptyProfile } from '@keyfall/typing-core'
import { CORPUS } from '../src/game/corpus'
import { createRng } from '../src/game/rng'
import { WordSelector } from '../src/game/selector'
import { RunSession } from '../src/game/session'
import { spreadExposure, typistProfile } from './profiles'

const LOW = 0.15
const HIGH = 0.9
const NONE: ReadonlySet<string> = new Set()
const B_WEAK = ['nt', 'st']

/**
 * Every profile here carries exposure counts, because every real one does.
 * A pool where the player has met every word equally often has no exploration
 * bucket by definition, which is a case the game does not produce.
 */
const EXPOSURE = spreadExposure(CORPUS.long)

function player(slow: Record<string, number> = {}) {
  return typistProfile({ slow, exposure: EXPOSURE })
}

/** Total variation distance between two served distributions, in [0, 1]. */
function divergence(a: readonly string[], b: readonly string[]): number {
  const share = (words: readonly string[]) => {
    const out = new Map<string, number>()
    for (const w of words) out.set(w, (out.get(w) ?? 0) + 1 / words.length)
    return out
  }
  const one = share(a)
  const two = share(b)
  let sum = 0
  for (const word of new Set([...one.keys(), ...two.keys()])) {
    sum += Math.abs((one.get(word) ?? 0) - (two.get(word) ?? 0))
  }
  return sum / 2
}

function concentration(words: readonly string[]): { top: number; distinct: number } {
  const counts = new Map<string, number>()
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
  return { top: Math.max(...counts.values()) / words.length, distinct: counts.size }
}

/** Draws `count` words from the long band at a fixed pressure. */
function draw(selector: WordSelector, count: number, pressure: number, seed = 5): string[] {
  const rng = createRng(seed)
  const words: string[] = []
  for (let i = 0; i < count; i++) words.push(selector.next('long', pressure, NONE, rng))
  return words
}

function shareContaining(words: readonly string[], digrams: readonly string[]): number {
  const hits = words.filter((w) => digrams.some((d) => w.includes(d))).length
  return hits / words.length
}

describe('the word selector', () => {
  test('an empty profile does not pretend to adapt', () => {
    const selector = new WordSelector(emptyProfile(0))
    const words = draw(selector, 200, LOW)

    expect(selector.report().adapting).toBe(false)
    expect(words.every((w) => CORPUS.long.includes(w))).toBe(true)
    // Nothing to steer on means nothing is steered, so the spread stays wide.
    expect(new Set(words).size).toBeGreaterThan(50)
  })

  test('a played-in profile adapts', () => {
    const selector = new WordSelector(player({ li: 2.4 }))
    draw(selector, 100, LOW)

    const report = selector.report()
    expect(report.adapting).toBe(true)
    expect(report.counts.weakness).toBeGreaterThan(0)
    expect(report.trained.some((t) => t.digram === 'l i')).toBe(true)
  })

  test('a word already in the arena is never served again', () => {
    const selector = new WordSelector(player())
    const rng = createRng(3)
    const held = new Set(CORPUS.long.slice(0, 70))

    for (let i = 0; i < 200; i++) {
      expect(held.has(selector.next('long', LOW, held, rng))).toBe(false)
    }
  })
})

describe('pressure bands', () => {
  test('a band holds until pressure clears the margin', () => {
    const selector = new WordSelector(player())
    const rng = createRng(7)

    expect(selector.currentBand()).toBe('low')

    // Past the threshold but inside the margin, so nothing moves.
    selector.next('long', 0.4, NONE, rng)
    expect(selector.currentBand()).toBe('low')

    selector.next('long', 0.45, NONE, rng)
    expect(selector.currentBand()).toBe('medium')

    // Coming back needs the same margin on the other side.
    selector.next('long', 0.3, NONE, rng)
    expect(selector.currentBand()).toBe('medium')

    selector.next('long', 0.2, NONE, rng)
    expect(selector.currentBand()).toBe('low')
  })

  test('pressure hovering on a threshold does not flip the mix', () => {
    const selector = new WordSelector(player())
    const rng = createRng(11)
    const bands = new Set<string>()

    for (let i = 0; i < 200; i++) {
      // Oscillating either side of the low-to-medium threshold, inside the margin.
      selector.next('long', i % 2 === 0 ? 0.33 : 0.4, NONE, rng)
      bands.add(selector.currentBand())
    }

    expect([...bands]).toEqual(['low'])
  })

  /**
   * The policy from product principle 7, stated as a test.
   *
   * A player under real pressure gets easier material, not their worst digram.
   * Adaptation that piles on at the moment of difficulty is the version that
   * reads as punishment.
   */
  test('a crowded arena withdraws the weakness training', () => {
    const profile = player({ li: 2.4, ra: 2.4, nt: 2.4 })

    const calm = new WordSelector(profile)
    draw(calm, 400, LOW)

    const pressed = new WordSelector(profile)
    draw(pressed, 400, HIGH)

    expect(calm.report().counts.weakness).toBeGreaterThan(
      pressed.report().counts.weakness * 3,
    )
    expect(pressed.report().counts.comfort).toBeGreaterThan(calm.report().counts.comfort)
  })
})

describe('the anti-drill cap', () => {
  test('no ten consecutive spawns hold more than three weakness words', () => {
    const selector = new WordSelector(
      player({ li: 2.4, ra: 2.4, nt: 2.4, st: 2.4 }),
    )
    const rng = createRng(13)

    const buckets: (string | null)[] = []
    for (let i = 0; i < 600; i++) {
      selector.next('long', LOW, NONE, rng)
      buckets.push(selector.lastBucket())
    }

    for (let i = 0; i + 10 <= buckets.length; i++) {
      const window = buckets.slice(i, i + 10).filter((b) => b === 'weakness').length
      expect(window, `window at ${i}`).toBeLessThanOrEqual(3)
    }
  })

  test('a run never leans on one word', () => {
    const selector = new WordSelector(
      player({ li: 2.6, ra: 2.6 }),
    )
    const words = draw(selector, 600, LOW)

    const counts = new Map<string, number>()
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)

    const busiest = Math.max(...counts.values())
    expect(busiest / words.length).toBeLessThan(0.06)
    expect(counts.size).toBeGreaterThan(CORPUS.long.length / 2)
  })
})

/**
 * Milestone 3's exit criterion, as far as a test can carry it.
 *
 * "Two typists with different weaknesses receive visibly different challenge
 * distributions without obvious repetitive drilling." Whether that *feels*
 * smart rather than manipulative is section 21 question 9 and needs a person.
 * Whether the distributions actually differ is arithmetic, and this is it.
 */
/**
 * Milestone 3's exit criterion, as far as a test can carry it.
 *
 * "Two typists with different weaknesses receive visibly different challenge
 * distributions without obvious repetitive drilling." Whether adaptation
 * *feels* smart rather than manipulative is section 21 question 9 and needs a
 * person. Whether the distributions actually differ is arithmetic.
 *
 * The measure is total variation distance between the two sets of words served,
 * against the distance between two runs of the *same* profile on different
 * seeds. That second number is the noise floor, and without it a large distance
 * would only be proving the sampler is random.
 *
 * Per-digram rates are deliberately not the headline measure. A pair's base
 * rate in the corpus swamps the comparison: `on` is already in three quarters
 * of the long band, so no amount of adaptation can move it far, while `nt` at a
 * fifth has room to nearly double. Both are the selector working.
 */
describe('two typists, two distributions', () => {
  const DRAWS = 800

  test('different weaknesses diverge far beyond seed noise', () => {
    const a = player({ li: 2.4, ra: 2.4 })
    const b = player({ nt: 2.4, st: 2.4 })

    const floor = divergence(draw(new WordSelector(a), DRAWS, LOW, 5), draw(new WordSelector(a), DRAWS, LOW, 91))
    const across = divergence(draw(new WordSelector(a), DRAWS, LOW, 5), draw(new WordSelector(b), DRAWS, LOW, 5))

    expect(floor).toBeLessThan(0.2)
    expect(across).toBeGreaterThan(floor * 3)
  })

  test('a weakness with room in the corpus is visibly boosted', () => {
    // `nt` and `st` sit in about a fifth of the long band, so there is headroom.
    const weak = draw(new WordSelector(player({ nt: 2.4, st: 2.4 })), DRAWS, LOW)
    const control = draw(new WordSelector(player()), DRAWS, LOW)

    expect(shareContaining(weak, B_WEAK)).toBeGreaterThan(shareContaining(control, B_WEAK) * 1.25)
  })

  /**
   * A weakness the corpus already serves constantly must not be served *less*.
   *
   * `io` is in nearly three quarters of the long band. There is little room to
   * boost it and no excuse for suppressing it, and suppressing it is exactly
   * what an earlier version did: filing every word containing a weak pair under
   * weakness put most of the corpus behind the anti-drill cap, so the other
   * buckets could only draw from what was left. The player weak at `on` met it
   * 21 percent of the time against another player's 78.
   */
  test('a near-universal weakness is not suppressed by the cap', () => {
    const weak = draw(new WordSelector(player({ io: 2.4, on: 2.4 })), DRAWS, LOW)
    const control = draw(new WordSelector(player()), DRAWS, LOW)

    expect(shareContaining(weak, ['io', 'on'])).toBeGreaterThanOrEqual(
      shareContaining(control, ['io', 'on']),
    )
  })

  /**
   * The anti-drilling half, as a controlled comparison.
   *
   * The claim is that targeting a weakness does not narrow the game, so the
   * comparison that matters is against the same selector with nothing to
   * target. An absolute threshold would be measuring the sampler's own spread.
   */
  test('targeting a weakness does not narrow what the player sees', () => {
    const control = concentration(draw(new WordSelector(player()), DRAWS, LOW))

    const cases: Record<string, number>[] = [{ li: 2.4, ra: 2.4 }, { nt: 2.4, st: 2.4 }]
    for (const slow of cases) {
      const adapted = concentration(draw(new WordSelector(player(slow)), DRAWS, LOW))

      expect(adapted.top).toBeLessThan(control.top * 1.25)
      expect(adapted.distinct).toBeGreaterThan(control.distinct * 0.9)
      // And an absolute floor, so a jointly bad pair cannot pass by matching.
      expect(adapted.top).toBeLessThan(0.07)
      expect(adapted.distinct).toBeGreaterThan(CORPUS.long.length * 0.7)
    }
  })
})

/**
 * The wiring, end to end.
 *
 * Everything above tests the selector directly. These play actual runs, because
 * the parts that can silently fail are the seams: the profile reaching the
 * session, the director's pressure reaching the selector, and the report
 * reaching the summary.
 */
describe('through a whole run', () => {
  function playOut(session: RunSession): void {
    let clock = 0
    let nextKeyAtMs = 0
    while (session.phase === 'playing' && clock < 8 * 60 * 1000) {
      clock += 16
      session.update(clock, 16)
      while (nextKeyAtMs <= clock) {
        const locked = session.lockedEnemy()
        const char = locked
          ? (locked.word[locked.typed] ?? null)
          : (session.targets().filter((e) => e.word.startsWith(session.prefix))
              .reduce<string | null>((best, e) => best ?? (e.word[session.prefix.length] ?? null), null))
        if (char === null) {
          nextKeyAtMs = clock + 80
          break
        }
        session.key(char, nextKeyAtMs)
        nextKeyAtMs += 80
      }
    }
  }

  test('a run against a played-in profile adapts and says what it trained', () => {
    const session = new RunSession()
    session.adoptProfile(typistProfile({ slow: { li: 2.6, ra: 2.6, nt: 2.6 } }))
    session.start(0, 7)
    playOut(session)

    const selection = session.currentSummary()!.selection
    expect(selection.adapting).toBe(true)
    expect(selection.counts.weakness).toBeGreaterThan(0)
    expect(selection.trained.length).toBeGreaterThan(0)
    expect(selection.trained.map((t) => t.digram)).toContain('l i')
  })

  test('a run against a fresh profile does not claim to adapt', () => {
    const session = new RunSession()
    session.start(0, 7)
    playOut(session)

    const selection = session.currentSummary()!.selection
    expect(selection.adapting).toBe(false)
    expect(selection.trained).toEqual([])
  })

  /**
   * The profile is adopted for the *next* run, never the one in progress.
   *
   * A run whose material changed halfway through because a write landed is a
   * run the player cannot make sense of afterwards.
   */
  test('adopting a profile mid-run leaves that run alone', () => {
    const session = new RunSession()
    session.start(0, 7)
    session.update(2000, 16)
    session.adoptProfile(typistProfile({ slow: { li: 2.6 } }))
    playOut(session)

    expect(session.currentSummary()!.selection.adapting).toBe(false)
  })
})

describe('naming a slow reach', () => {
  test('a run reports the key when the model has found one', () => {
    const selector = new WordSelector(
      typistProfile({ slowLanding: { t: 1.7 }, exposure: EXPOSURE }),
    )
    draw(selector, 400, LOW)

    const report = selector.report()
    expect(report.counts.weakness).toBeGreaterThan(0)
    expect(report.reaches.map((r) => r.key)).toContain('t')
  })

  test('a run reports no reach when the weakness is not about one key', () => {
    const selector = new WordSelector(player({ li: 2.6, ra: 2.6 }))
    draw(selector, 400, LOW)

    const report = selector.report()
    expect(report.counts.weakness).toBeGreaterThan(0)
    expect(report.reaches).toEqual([])
  })

  test('a reach the run never served is not claimed', () => {
    // Only the short band is drawn from, so a reach the run never put in front
    // of the player must not appear in what the run says it trained.
    const selector = new WordSelector(
      typistProfile({ slowLanding: { t: 1.7 }, exposure: EXPOSURE }),
    )
    const rng = createRng(5)
    for (let i = 0; i < 200; i++) selector.next('short', HIGH, NONE, rng)

    for (const reach of selector.report().reaches) {
      expect(selector.report().trained.some((t) => t.digram.endsWith(reach.key))).toBe(true)
    }
  })
})
