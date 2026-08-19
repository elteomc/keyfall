import { describe, expect, test } from 'vitest'
import { ARENA_WIDTH, BASELINE_Y, REVEAL_Y, type Enemy, RunSession } from '../src/game/session'

/**
 * Synthetic typists driving the session on a fake clock.
 *
 * The point is not to prove the game is fun. It is to prove that the run
 * lifecycle, the lock semantics, and the summary hold together without a
 * browser, which is what makes the game layer testable at all.
 */
function driver(seed = 42) {
  const session = new RunSession()
  let clock = 0

  session.start(clock, seed)

  return {
    session,
    now: () => clock,
    /** Advance the world in 16 ms frames. */
    advance(totalMs: number) {
      let left = totalMs
      while (left > 0) {
        const dt = Math.min(16, left)
        clock += dt
        session.update(clock, dt)
        left -= dt
      }
    },
    /** Type a string with a fixed interval between keystrokes. */
    type(text: string, intervalMs = 80) {
      for (const char of text) {
        clock += intervalMs
        session.key(char, clock)
      }
    },
  }
}

/** A revealed enemy parked at a known height, for tests that need exact words. */
function fakeEnemy(id: string, word: string, y: number): Enemy {
  return { id, word, kind: 'drone', x: 500, y, speed: 0, typed: 0, spawnedAtMs: 0 }
}

/** Types a run of clean words, one target at a time, to build a combo. */
function buildCombo(run: ReturnType<typeof driver>, rounds: number): void {
  for (let round = 0; round < rounds; round++) {
    run.session.enemies = [fakeEnemy(`c${round}`, 'vector', 200)]
    run.type('vector', 90)
  }
}

describe('RunSession', () => {
  test('a run starts on the title screen and enters play on start', () => {
    const fresh = new RunSession()
    expect(fresh.phase).toBe('title')

    fresh.start(0, 1)
    expect(fresh.phase).toBe('playing')
    expect(fresh.lives).toBe(3)
  })

  test('spawning fills the arena over time', () => {
    const run = driver()
    run.advance(6000)
    expect(run.session.enemies.length).toBeGreaterThan(1)
  })

  test('typing a word destroys exactly that enemy', () => {
    const run = driver()
    run.advance(4000)

    const target = run.session.enemies[0]!
    const others = run.session.enemies.length - 1

    run.type(target.word)

    expect(run.session.enemies.some((e) => e.id === target.id)).toBe(false)
    expect(run.session.enemies.length).toBe(others)
    expect(run.session.kills).toBe(1)
    expect(run.session.score).toBeGreaterThan(0)
    expect(run.session.lockedId).toBeNull()
  })

  test('an enemy above the reveal line cannot be targeted', () => {
    const run = driver()
    run.advance(4000)

    const enemy = run.session.enemies[0]!
    enemy.y = REVEAL_Y - 1

    expect(run.session.targets().some((e) => e.id === enemy.id)).toBe(false)

    run.type(enemy.word[0]!)
    expect(run.session.lockedId).toBeNull()
    expect(enemy.typed).toBe(0)
  })

  test('a key aimed at an unrevealed word is ignored, not counted as an error', () => {
    const run = driver()
    run.advance(4000)

    // Only one enemy, held above the reveal line.
    const enemy = run.session.enemies[0]!
    run.session.enemies = [enemy]
    enemy.y = REVEAL_Y - 1

    run.type(enemy.word[0]!)
    run.advance(120000)

    expect(run.session.currentSummary()!.accuracy).toBe(1)
  })

  test('a wrong key keeps the lock and only costs accuracy', () => {
    const run = driver()
    run.advance(4000)

    const target = run.session.enemies[0]!
    run.type(target.word.slice(0, 2))
    const lockedId = run.session.lockedId
    expect(lockedId).not.toBeNull()

    const locked = run.session.lockedEnemy()!
    const typedBefore = locked.typed
    const expected = locked.word[locked.typed]
    run.type(expected === 'q' ? 'z' : 'q')

    expect(run.session.lockedId).toBe(lockedId)
    expect(run.session.lockedEnemy()!.typed).toBe(typedBefore)

    run.advance(120000)
    expect(run.session.currentSummary()!.accuracy).toBeLessThan(1)
  })

  test('escape releases the target and resets its progress', () => {
    const run = driver()
    run.advance(4000)

    run.type(run.session.enemies[0]!.word.slice(0, 2))
    expect(run.session.lockedId).not.toBeNull()

    run.session.cancelLock()
    expect(run.session.lockedId).toBeNull()
    expect(run.session.enemies.every((e) => e.typed === 0)).toBe(true)
  })

  test('spawned words stay inside the arena and clear their neighbours', () => {
    const run = driver(11)
    const seen = new Set<string>()
    // A monospace advance of 13.2 at 22px, matching the renderer.
    const halfWidth = (word: string) => (word.length * 13.2) / 2

    for (let tick = 0; tick < 400; tick++) {
      run.advance(120)
      // Stand in for a player who clears the arena, so the run keeps spawning
      // instead of ending after three breaches.
      run.session.enemies = run.session.enemies.filter((e) => e.y < 500)

      for (const enemy of run.session.enemies) {
        if (seen.has(enemy.id)) continue
        seen.add(enemy.id)

        const half = halfWidth(enemy.word)
        expect(enemy.x - half).toBeGreaterThanOrEqual(0)
        expect(enemy.x + half).toBeLessThanOrEqual(ARENA_WIDTH)

        // With at most two neighbours in the band there is always room, so a
        // clean slot is expected rather than merely likely.
        const band = run.session.enemies.filter(
          (e) => e.id !== enemy.id && Math.abs(e.y - enemy.y) < 140,
        )
        if (band.length > 2) continue
        for (const other of band) {
          expect(Math.abs(other.x - enemy.x)).toBeGreaterThanOrEqual(half + halfWidth(other.word))
        }
      }
    }

    expect(seen.size).toBeGreaterThan(20)
  })

  test('a prefix whose targets are gone does not poison the next keystroke', () => {
    const run = driver()
    run.advance(4000)

    run.session.enemies = [
      fakeEnemy('a', 'travel', 200),
      fakeEnemy('b', 'traffic', 240),
      fakeEnemy('c', 'vector', 280),
    ]

    run.type('tr')
    expect(run.session.prefix).toBe('tr')
    expect(run.session.lockedId).toBeNull()

    // Both `tr` words leave the arena.
    run.session.enemies = [fakeEnemy('c', 'vector', 300)]
    run.advance(120)
    expect(run.session.prefix).toBe('')

    // The next key is a clean start on the survivor, not a miss against ghosts.
    run.type('v')
    expect(run.session.lockedId).toBe('c')

    run.advance(120000)
    expect(run.session.currentSummary()!.accuracy).toBe(1)
  })

  test('abandoning a word does not inflate the next acquisition latency', () => {
    const run = driver()
    run.advance(4000)

    run.session.enemies = [fakeEnemy('a', 'travel', 200), fakeEnemy('b', 'vector', 300)]

    run.type('tra')
    expect(run.session.lockedId).toBe('a')

    // Five seconds of staring at a word the player then gives up on.
    run.advance(5000)
    run.session.cancelLock(run.now())

    run.type('vector', 80)
    expect(run.session.kills).toBe(1)

    run.advance(120000)
    const acquisition = run.session.currentSummary()!.acquisitionMs!
    expect(acquisition).toBeLessThan(500)
  })

  test('a reflex space is recorded but never counted as a mistake', () => {
    const run = driver()
    run.advance(4000)

    run.session.enemies = [fakeEnemy('a', 'travel', 200)]
    run.type('travel')

    const eventsBefore = run.session.eventCount()
    run.type('   ')

    expect(run.session.eventCount()).toBe(eventsBefore + 3)
    expect(run.session.lastErrorAtMs).toBe(-Infinity)

    run.advance(120000)
    expect(run.session.currentSummary()!.accuracy).toBe(1)
  })

  test('a miss before a word does not dilute that word', () => {
    const clean = driver(5)
    clean.advance(4000)
    clean.session.enemies = [fakeEnemy('a', 'vector', 200)]
    clean.type('vector', 90)

    const fumbled = driver(5)
    fumbled.advance(4000)
    fumbled.session.enemies = [fakeEnemy('a', 'vector', 200)]
    // `q` starts nothing on screen, so it is a miss that ends the window.
    fumbled.type('q', 90)
    fumbled.type('vector', 90)

    expect(fumbled.session.combo()).toBeCloseTo(clean.session.combo(), 10)
  })

  test('keys spent on an abandoned word are not charged to the next one', () => {
    const clean = driver(5)
    clean.advance(4000)
    clean.session.enemies = [fakeEnemy('a', 'vector', 200)]
    clean.type('vector', 90)

    const abandoned = driver(5)
    abandoned.advance(4000)
    abandoned.session.enemies = [fakeEnemy('b', 'travel', 200), fakeEnemy('a', 'vector', 240)]
    abandoned.type('trav', 90)
    abandoned.session.cancelLock(abandoned.now())
    abandoned.type('vector', 90)

    expect(abandoned.session.combo()).toBeCloseTo(clean.session.combo(), 10)
  })

  test('standing still with readable targets bleeds the combo', () => {
    const run = driver(5)
    run.advance(4000)
    run.session.enemies = [fakeEnemy('a', 'vector', 200)]
    run.type('vector', 90)

    const earned = run.session.combo()
    expect(earned).toBeGreaterThan(0)

    run.session.enemies = [fakeEnemy('b', 'travel', 200)]
    run.advance(4000)

    expect(run.session.combo()).toBeLessThan(earned)
  })

  test('an empty arena is the game pacing itself, not the player idling', () => {
    const run = driver(5)
    run.advance(4000)
    run.session.enemies = [fakeEnemy('a', 'vector', 200)]
    run.type('vector', 90)

    const earned = run.session.combo()

    // Nothing readable on screen, and spawning suppressed by clearing each tick.
    for (let tick = 0; tick < 30; tick++) {
      run.advance(100)
      run.session.enemies = []
    }

    expect(run.session.combo()).toBe(earned)
  })

  test('a climb in tier is stamped for the renderer', () => {
    const run = driver(5)
    run.advance(4000)
    expect(run.session.promotedTier).toBeNull()

    buildCombo(run, 6)
    run.advance(16)

    expect(run.session.promotedTier).not.toBeNull()
    expect(run.session.tierPromotedAtMs).toBeGreaterThan(0)
    expect(run.session.comboTier()).not.toBe('flat')
  })

  test('a wrong key on a shield loses the whole word, not one character', () => {
    const run = driver()
    run.advance(4000)

    const shield: Enemy = { ...fakeEnemy('s', 'kernel', 200), kind: 'shield' }
    run.session.enemies = [shield]

    run.type('kern')
    expect(shield.typed).toBe(4)

    run.type('x')
    expect(shield.typed).toBe(0)
    expect(run.session.lockedId).toBe('s')

    // The word is still killable, it just has to be earned again.
    run.type('kernel')
    expect(run.session.kills).toBe(1)
  })

  test('a wrong key on any other archetype keeps the progress', () => {
    const run = driver()
    run.advance(4000)

    const drone: Enemy = { ...fakeEnemy('d', 'kernel', 200), kind: 'drone' }
    run.session.enemies = [drone]

    run.type('kern')
    run.type('x')
    expect(drone.typed).toBe(4)
  })

  test('a sprinter carries a short word and outruns a tank', () => {
    const run = driver(3)
    run.advance(4000)

    const speeds: Partial<Record<string, number>> = {}
    const lengths: Partial<Record<string, number>> = {}
    for (let tick = 0; tick < 600; tick++) {
      run.advance(120)
      for (const enemy of run.session.enemies) {
        speeds[enemy.kind] = Math.max(speeds[enemy.kind] ?? 0, enemy.speed)
        lengths[enemy.kind] = Math.max(lengths[enemy.kind] ?? 0, enemy.word.length)
      }
      // A player who clears everything, so the director sees low pressure and
      // the run is allowed to get harder.
      run.session.enemies = []
    }

    expect(speeds.sprinter).toBeGreaterThan(speeds.tank!)
    expect(lengths.sprinter!).toBeLessThan(lengths.tank!)
  })

  test('the director opens easy and every archetype eventually appears', () => {
    const run = driver(3)
    const early = new Set<string>()
    const all = new Set<string>()

    for (let tick = 0; tick < 600; tick++) {
      run.advance(120)
      for (const enemy of run.session.enemies) {
        all.add(enemy.kind)
        if (run.session.elapsedMs < 10000) early.add(enemy.kind)
      }
      run.session.enemies = []
    }

    expect([...early]).toEqual(['drone'])
    expect([...all].sort()).toEqual(['drone', 'shield', 'sprinter', 'swarm', 'tank'])
    expect(run.session.intensity()).toBeGreaterThan(0)
  })

  test('a breach costs a life and three breaches end the run', () => {
    const run = driver()
    run.advance(4000)
    expect(run.session.lives).toBe(3)

    // Long enough for several enemies to cross the baseline untouched.
    run.advance(120000)

    expect(run.session.phase).toBe('over')
    expect(run.session.lives).toBe(0)
    expect(run.session.enemies.every((e) => e.y < BASELINE_Y)).toBe(true)

    const summary = run.session.currentSummary()
    expect(summary).not.toBeNull()
    expect(summary!.timeMs).toBeGreaterThan(0)
    expect(summary!.accuracy).toBe(1)
  })

  test('the summary reports typing measurements after real play', () => {
    const run = driver(7)

    for (let round = 0; round < 6; round++) {
      run.advance(3000)
      const target = run.session.enemies[0]
      if (!target) continue
      run.type(target.word, 90)
    }

    run.advance(120000)
    const summary = run.session.currentSummary()!

    expect(summary.kills).toBeGreaterThanOrEqual(5)
    expect(summary.wpm).toBeGreaterThan(0)
    expect(summary.peakBurstWpm).toBeGreaterThan(0)
    expect(summary.rhythm).not.toBeNull()
    expect(summary.acquisitionMs).not.toBeNull()
    // Transition timings need repeated samples, so a short run can report none.
    expect(Array.isArray(summary.slowest)).toBe(true)
  })

  test('clean typing builds a combo and lifts its tier', () => {
    const run = driver()
    run.advance(4000)
    expect(run.session.combo()).toBe(0)
    expect(run.session.comboTier()).toBe('flat')

    buildCombo(run, 8)

    expect(run.session.kills).toBe(8)
    expect(run.session.combo()).toBeGreaterThan(0)
    expect(run.session.comboTier()).not.toBe('flat')

    // A new run is a clean slate, not a continuation of the last one.
    run.session.start(run.now(), 3)
    expect(run.session.combo()).toBe(0)
    expect(run.session.comboTier()).toBe('flat')
  })

  test('an error cuts into the combo the player has built', () => {
    const run = driver()
    run.advance(4000)
    buildCombo(run, 6)

    const built = run.session.combo()
    expect(built).toBeGreaterThan(0)

    // 'q' is wrong wherever it lands in 'vector'.
    run.session.enemies = [fakeEnemy('x', 'vector', 200)]
    run.type('v', 90)
    run.type('q', 90)

    expect(run.session.combo()).toBeLessThan(built)
  })

  test('the same words are worth more to a player typing them cleanly', () => {
    const clean = driver(5)
    clean.advance(4000)
    buildCombo(clean, 6)

    const shaky = driver(5)
    shaky.advance(4000)
    for (let round = 0; round < 6; round++) {
      shaky.session.enemies = [fakeEnemy(`c${round}`, 'vector', 200)]
      // One wrong key per word, then the word itself. Same six kills.
      shaky.type('q', 90)
      shaky.type('vector', 90)
    }

    expect(shaky.session.kills).toBe(clean.session.kills)
    expect(shaky.session.score).toBeLessThan(clean.session.score)
  })

  test('a breach costs the combo as well as a life', () => {
    const run = driver()
    run.advance(4000)
    buildCombo(run, 6)

    const built = run.session.combo()
    run.session.enemies = [fakeEnemy('x', 'vector', BASELINE_Y)]
    run.advance(32)

    expect(run.session.lives).toBe(2)
    expect(run.session.combo()).toBeLessThan(built)
  })
})
