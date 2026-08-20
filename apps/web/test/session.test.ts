import { describe, expect, test } from 'vitest'
import { ARENA_WIDTH, BASELINE_Y, type Enemy, RunSession } from '../src/game/session'

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

/**
 * A player who keeps the arena clear by actually typing it clear.
 *
 * Wiping `enemies` directly is no longer a strong player. The director measures
 * load against the player's own typing speed, so an arena that empties without
 * a keystroke reads as a slow typist drowning rather than a fast one coasting.
 */
function typeEverything(run: ReturnType<typeof driver>, intervalMs = 30): void {
  const session = run.session
  let guard = 0

  while (session.targets().length > 0 && guard++ < 300) {
    const locked = session.lockedEnemy()
    if (locked) {
      const char = locked.word[locked.typed]
      if (char === undefined) break
      run.type(char, intervalMs)
      continue
    }

    // Follow the session's own prefix. Restarting each word instead would turn
    // every shared first letter into a miss, which models someone fighting the
    // lock rather than a strong player.
    const matching = session.targets().filter((e) => e.word.startsWith(session.prefix))
    if (matching.length === 0) {
      session.cancelLock()
      break
    }
    const target = matching.reduce((a, b) => (b.y > a.y ? b : a))
    const char = target.word[session.prefix.length]
    if (char === undefined) break
    run.type(char, intervalMs)
  }
}

/** A revealed enemy parked at a known height, for tests that need exact words. */
function fakeEnemy(id: string, word: string, y: number): Enemy {
  return {
    id,
    word,
    kind: 'drone',
    x: 500,
    y,
    speed: 0,
    typed: 0,
    spawnedAtMs: 0,
    hitAtMs: -Infinity,
  }
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

  test('a word still fading in can already be typed', () => {
    const run = driver()
    run.advance(4000)

    const enemy = run.session.enemies[0]!
    enemy.y = -10

    // If it is in the arena it is a candidate. Anything else creates a window
    // where the player can read a word the game will not accept.
    expect(run.session.targets().some((e) => e.id === enemy.id)).toBe(true)
  })

  test('the word you are looking at is not stolen by another', () => {
    const run = driver()
    run.advance(4000)

    // The reported bug: "packet" was fading in and "pattern" was not, so p-a
    // locked pattern and every following key was charged against it. The player
    // typed packet perfectly and heard three wrong-key sounds.
    run.session.enemies = [fakeEnemy('a', 'pattern', 300), { ...fakeEnemy('b', 'packet', -10) }]

    run.type('packet')

    expect(run.session.kills).toBe(1)
    expect(run.session.enemies.map((e) => e.word)).toEqual(['pattern'])
    run.advance(120000)
    expect(run.session.currentSummary()!.accuracy).toBe(1)
  })

  test('keys already in flight when the target dies are not charged', () => {
    const run = driver()
    run.advance(4000)

    run.session.enemies = [fakeEnemy('a', 'packet', 300), fakeEnemy('b', 'signal', 300)]
    run.type('pa')

    // The word breaches out from under the player mid-prefix.
    run.session.enemies = run.session.enemies.filter((e) => e.word !== 'packet')
    run.advance(16)

    const before = run.session.eventCount()
    run.type('cket', 40)

    // Dropped rather than charged: they were the player's intent a moment ago.
    expect(run.session.eventCount()).toBe(before)
    run.advance(120000)
    expect(run.session.currentSummary()!.accuracy).toBe(1)
  })

  test('a slip does not cost the word, and is charged once', () => {
    const run = driver()
    run.advance(4000)
    run.session.enemies = [fakeEnemy('a', 'packet', 300)]

    // One slip, then the player carries on at speed without noticing.
    run.type('pac', 40)
    run.type('j', 40)
    run.type('et', 40)

    expect(run.session.kills).toBe(1)
    run.advance(120000)

    const summary = run.session.currentSummary()!
    // Six keys sent, one of them wrong. Charged once, not once per key that
    // followed it, and the fumbled 'k' is skipped rather than demanded back.
    expect(summary.accuracy).toBeCloseTo(5 / 6, 5)
  })

  test('a slip can be fixed by retyping the letter that was missed', () => {
    const run = driver()
    run.advance(4000)
    run.session.enemies = [fakeEnemy('a', 'packet', 300)]

    run.type('pac', 40)
    run.type('j', 40)
    // The player notices and goes back for the character they fumbled.
    run.type('ket', 40)

    expect(run.session.kills).toBe(1)
  })

  test('typing rubbish never destroys a word', () => {
    const run = driver()
    run.advance(4000)
    const enemy = fakeEnemy('a', 'packet', 300)
    run.session.enemies = [enemy]

    run.type('pac', 40)
    run.type('zzzzzzzz', 40)

    // Accuracy has to have stakes. A word may only be finished by typing it.
    expect(run.session.kills).toBe(0)
    expect(enemy.typed).toBe(3)
  })

  test('a shield still makes a mistake cost time', () => {
    const run = driver()
    run.advance(4000)
    run.session.enemies = [{ ...fakeEnemy('a', 'packet', 300), kind: 'shield' }]

    run.type('pac', 40)
    run.type('j', 40)

    // The one archetype where a slip sends you back to the start.
    expect(run.session.lockedEnemy()!.typed).toBe(0)
    expect(run.session.kills).toBe(0)
  })

  test('a slip early costs more combo than a slip late', () => {
    function comboAfterSlipAt(index: number): number {
      const run = driver()
      run.advance(4000)
      buildCombo(run, 14)
      const before = run.session.combo()

      run.session.enemies = [fakeEnemy('z', 'packet', 300)]
      run.type('packet'.slice(0, index), 40)
      run.type('q', 40)
      return before - run.session.combo()
    }

    // Spoiling a whole word should cost more than fumbling its last character.
    expect(comboAfterSlipAt(0)).toBeGreaterThan(comboAfterSlipAt(5))
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

  test('a sprinter carries a short word and outruns a tank', () => {
    const run = driver(3)
    run.advance(4000)

    const speeds: Partial<Record<string, number>> = {}
    const lengths: Partial<Record<string, number>> = {}
    for (let tick = 0; tick < 600; tick++) {
      run.advance(200)
      for (const enemy of run.session.enemies) {
        speeds[enemy.kind] = Math.max(speeds[enemy.kind] ?? 0, enemy.speed)
        lengths[enemy.kind] = Math.max(lengths[enemy.kind] ?? 0, enemy.word.length)
      }
      // A player who clears everything, so the director sees room to escalate.
      typeEverything(run)
    }

    expect(speeds.sprinter).toBeGreaterThan(speeds.tank!)
    expect(lengths.sprinter!).toBeLessThan(lengths.tank!)
  })

  test('the director opens easy and every archetype eventually appears', () => {
    const run = driver(3)
    const early = new Set<string>()
    const all = new Set<string>()

    for (let tick = 0; tick < 600; tick++) {
      run.advance(200)
      for (const enemy of run.session.enemies) {
        all.add(enemy.kind)
        if (run.session.elapsedMs < 10000) early.add(enemy.kind)
      }
      typeEverything(run)
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

  test('feedback is emitted for every event worth seeing and hearing', () => {
    const run = driver()
    run.advance(4000)
    run.session.drainFeedback()

    run.session.enemies = [fakeEnemy('a', 'vector', 200)]
    run.type('ve', 90)
    run.type('q', 90)
    run.type('tor', 90)

    const kinds = run.session.drainFeedback().map((f) => f.kind)
    expect(kinds.filter((k) => k === 'hit')).toHaveLength(5)
    expect(kinds).toContain('miss')
    expect(kinds).toContain('kill')

    // Draining is destructive, so nothing is replayed a frame late.
    expect(run.session.drainFeedback()).toEqual([])
  })

  test('a hit reports where it landed and how far the word has come', () => {
    const run = driver()
    run.advance(4000)
    run.session.drainFeedback()

    run.session.enemies = [fakeEnemy('a', 'vector', 200)]
    run.type('vec', 90)

    const hits = run.session.drainFeedback().filter((f) => f.kind === 'hit')
    expect(hits.map((h) => h.progress)).toEqual([1 / 6, 2 / 6, 3 / 6])
    expect(hits.every((h) => h.x === 500 && h.y === 200)).toBe(true)
    expect(run.session.enemies[0]!.hitAtMs).toBe(run.now())
  })

  test('undrained feedback is bounded rather than accumulated', () => {
    const run = driver()
    run.advance(4000)

    for (let round = 0; round < 40; round++) {
      run.session.enemies = [fakeEnemy(`c${round}`, 'vector', 200)]
      run.type('vector', 90)
    }

    // Seven events per word against a queue nobody drained.
    expect(run.session.drainFeedback().length).toBeLessThanOrEqual(96)
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
