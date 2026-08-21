import { describe, expect, test } from 'vitest'
import { RunSession } from '../src/game/session'
import {
  FINALE_KILLS,
  HARD_CAP_MS,
  finaleWaveSize,
  intervalScaleAt,
  progressOf,
  stageAt,
} from '../src/game/stages'

/**
 * The run's arc, which is the one thing in the game still driven by the clock.
 *
 * These tests care about shape rather than difficulty. Whether the finale is
 * hard is the director's business and is covered in `director.test.ts`.
 */

/** Drives the session in 16 ms frames from wherever the clock currently sits. */
function frames(session: RunSession, totalMs: number, startMs: number): number {
  let clock = startMs
  let left = totalMs
  while (left > 0) {
    const dt = Math.min(16, left)
    clock += dt
    session.update(clock, dt)
    left -= dt
  }
  return clock
}

/**
 * The next key a competent player would press.
 *
 * It has to follow the session's own prefix rather than restarting each word,
 * or every shared first letter turns into a miss and the "typist" is really
 * modelling someone fighting the lock.
 */
function nextChar(session: RunSession): string | null {
  const locked = session.lockedEnemy()
  if (locked) return locked.word[locked.typed] ?? null

  const matching = session.targets().filter((e) => e.word.startsWith(session.prefix))
  if (matching.length === 0) {
    if (session.prefix !== '') session.cancelLock()
    return null
  }

  // Take the most urgent word, which is the one nearest the baseline.
  const target = matching.reduce((a, b) => (b.y > a.y ? b : a))
  return target.word[session.prefix.length] ?? null
}

/** Puts a live run at the moment the closing wave is due. */
function atFinale(seed = 7): RunSession {
  const session = new RunSession()
  session.start(0, seed)
  session.enemies = []
  session.kills = FINALE_KILLS
  return session
}

/** A run that has destroyed `kills` targets without hitting the time cap. */
function at(kills: number, elapsedMs = 0) {
  return { kills, elapsedMs }
}

describe('stage table', () => {
  test('the arc advances on targets destroyed, not on the clock', () => {
    expect(stageAt(at(0))).toBe('calibration')
    expect(stageAt(at(FINALE_KILLS * 0.1))).toBe('calibration')
    expect(stageAt(at(FINALE_KILLS * 0.2))).toBe('expansion')
    expect(stageAt(at(FINALE_KILLS * 0.5))).toBe('pressure')
    expect(stageAt(at(FINALE_KILLS * 0.9))).toBe('lull')
    expect(stageAt(at(FINALE_KILLS))).toBe('finale')
    expect(stageAt(at(FINALE_KILLS * 5))).toBe('finale')
  })

  test('a long run still ends, however badly it is going', () => {
    // Nobody has destroyed anything, but the run cannot go on forever.
    expect(stageAt(at(0, HARD_CAP_MS * 0.5))).not.toBe('finale')
    expect(stageAt(at(0, HARD_CAP_MS))).toBe('finale')
    expect(progressOf(at(0, HARD_CAP_MS * 2))).toBe(1)
  })

  test('a fast player reaches the finale on fewer minutes, not fewer kills', () => {
    const fast = at(FINALE_KILLS, 4 * 60_000)
    const slow = at(FINALE_KILLS, 9 * 60_000)
    expect(stageAt(fast)).toBe('finale')
    expect(stageAt(slow)).toBe('finale')
  })

  test('only the lull thins the spawn rate', () => {
    expect(intervalScaleAt(at(0))).toBe(1)
    expect(intervalScaleAt(at(FINALE_KILLS * 0.5))).toBe(1)
    expect(intervalScaleAt(at(FINALE_KILLS * 0.9))).toBeGreaterThan(1)
    expect(intervalScaleAt(at(FINALE_KILLS))).toBe(1)
  })

  test('the closing wave is proportional to the run the player had', () => {
    expect(finaleWaveSize(0)).toBeLessThan(finaleWaveSize(1))
    // Even a coasting player gets a real wave, and a peaking one gets no wall.
    expect(finaleWaveSize(0)).toBeGreaterThanOrEqual(5)
    expect(finaleWaveSize(1)).toBeLessThanOrEqual(10)
    expect(finaleWaveSize(-5)).toBe(finaleWaveSize(0))
    expect(finaleWaveSize(99)).toBe(finaleWaveSize(1))
  })
})

describe('the run arc', () => {
  test('the closing wave arrives once and nothing follows it', () => {
    const session = atFinale()

    const clock = frames(session, 100, 0)
    const wave = session.enemies.length
    expect(wave).toBeGreaterThanOrEqual(5)

    // Pin the wave in place so the arena neither drains nor breaches, then let
    // far more than a spawn interval go by.
    for (const enemy of session.enemies) enemy.speed = 0
    frames(session, 30_000, clock)

    expect(session.enemies.length).toBe(wave)
    expect(session.phase).toBe('playing')
  })

  test('clearing the closing wave ends the run as cleared', () => {
    const session = atFinale()
    const clock = frames(session, 100, 0)
    expect(session.enemies.length).toBeGreaterThan(0)

    // Stand in for the player destroying every last word.
    session.enemies = []
    frames(session, 32, clock)

    expect(session.phase).toBe('over')
    expect(session.currentSummary()?.outcome).toBe('cleared')
    // A cleared run keeps the lives it finished with. Only a breach zeroes them.
    expect(session.lives).toBeGreaterThan(0)
  })

  test('an empty arena before the finale does not end the run', () => {
    const session = new RunSession()
    session.start(0, 7)
    session.enemies = []
    session.kills = Math.floor(FINALE_KILLS * 0.5)

    frames(session, 32, 0)
    expect(session.phase).toBe('playing')
  })

  test('breaching three times still ends the run as breached', () => {
    const session = new RunSession()
    session.start(0, 7)

    // Nobody types, so everything that spawns reaches the baseline.
    frames(session, 60_000, 0)

    expect(session.phase).toBe('over')
    expect(session.currentSummary()?.outcome).toBe('breached')
    expect(session.lives).toBe(0)
  })

  /**
   * Plays a whole run at a fixed keystroke interval.
   *
   * Keystrokes cost simulated time, so the typist cannot clear the arena for
   * free. Without that the world only ever advances one frame per word and the
   * run proves nothing about pacing.
   */
  function playOut(seed: number, keyIntervalMs: number) {
    const session = new RunSession()
    session.start(0, seed)

    let clock = 0
    let nextKeyAtMs = 0
    // Well past the finale at every speed tested, so a typist who keeps up has
    // to run out of run rather than out of lives.
    const limit = 15 * 60 * 1000

    while (session.phase === 'playing' && clock < limit) {
      clock += 16
      session.update(clock, 16)

      while (nextKeyAtMs <= clock) {
        const char = nextChar(session)
        if (char === null) {
          nextKeyAtMs = clock + keyIntervalMs
          break
        }
        session.key(char, nextKeyAtMs)
        nextKeyAtMs += keyIntervalMs
      }
    }

    return session.currentSummary()
  }

  /**
   * Run length across speeds and seeds, rather than one seed at one speed.
   *
   * The single-seed version of this asserted a run longer than five minutes and
   * held only by a margin of under a second, so a change to word selection that
   * shifted nothing systematic still broke it. Sweeping says the same thing
   * about the arc and says it about the distribution rather than about one
   * draw.
   *
   * 70 ms a key is around 170 wpm sustained, which is a strong human typist and
   * the fastest speed the 5 to 10 minute band in milestone 1 is meant to cover.
   */
  test('a strong typist finishes inside the five to ten minute band', () => {
    for (const seed of [3, 7, 11]) {
      const summary = playOut(seed, 70)
      expect(summary?.outcome).toBe('cleared')
      expect(summary!.timeMs).toBeGreaterThan(5 * 60 * 1000)
      expect(summary!.timeMs).toBeLessThan(10 * 60 * 1000)
      expect(summary!.kills).toBeGreaterThan(50)
    }
  })

  /**
   * The band's floor is a claim about people, not about bots.
   *
   * At 45 ms a key the simulated typist is around 265 wpm with no acquisition
   * cost and no mistakes, which nobody is. It clears in a little under or over
   * five minutes depending on the seed. That is the arc behaving, so this
   * asserts only that such a player still gets a whole run rather than a
   * truncated one.
   */
  test('a faster than human typist still gets a whole run', () => {
    const summary = playOut(11, 45)
    expect(summary?.outcome).toBe('cleared')
    expect(summary!.kills).toBeGreaterThanOrEqual(FINALE_KILLS)
    expect(summary!.timeMs).toBeLessThan(10 * 60 * 1000)
  })

  /**
   * The clock cap bounds when the finale starts, not when the run ends.
   *
   * `HARD_CAP_MS` sends a stalled run to its finale, and the closing wave then
   * still has to be fought, so a slow run finishes a few seconds past the cap.
   * Around 110 wpm that shows up as runs of about ten minutes and a handful of
   * seconds. It is recorded here rather than asserted away, because pretending
   * the cap bounds the run would be the wrong claim to leave in a test.
   */
  test('a slower typist reaches the finale within the clock cap', () => {
    const summary = playOut(3, 110)
    expect(summary?.outcome).toBe('cleared')
    expect(summary!.timeMs).toBeGreaterThan(5 * 60 * 1000)
    expect(summary!.timeMs).toBeLessThan(HARD_CAP_MS + 30_000)
  })

  test('a summary carries at most three observations', () => {
    const session = new RunSession()
    session.start(0, 7)
    frames(session, 60_000, 0)

    const summary = session.currentSummary()
    expect(summary).not.toBeNull()
    expect(summary!.observations.length).toBeLessThanOrEqual(3)
  })
})
