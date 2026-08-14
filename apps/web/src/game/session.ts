import {
  type EventRecorder,
  type TransitionStat,
  TransitionTable,
  accuracy,
  createRecorder,
  interKeyIntervals,
  mean,
  resolveLockedKey,
  resolveUnlockedKey,
  rhythmScore,
  wordsPerMinute,
} from '@keyfall/typing-core'

import { type Band, pickWord } from './corpus'
import { type Rng, createRng } from './rng'

/** The arena is a fixed logical space. The renderer scales it to the window. */
export const ARENA_WIDTH = 1000
export const ARENA_HEIGHT = 700
export const BASELINE_Y = ARENA_HEIGHT - 74

/**
 * Enemies spawn above the arena and are not targetable until they have fallen
 * past this line. Locking a word the player cannot read yet feels like a
 * misfire, so prefix resolution ignores anything above it.
 */
export const REVEAL_Y = 18

export type Phase = 'title' | 'playing' | 'over'
export type EnemyKind = 'drone' | 'swarm' | 'tank'

export interface Enemy {
  id: string
  word: string
  kind: EnemyKind
  x: number
  y: number
  speed: number
  typed: number
  spawnedAtMs: number
}

export interface Beam {
  x: number
  y: number
  untilMs: number
}

export interface RunSummary {
  score: number
  timeMs: number
  kills: number
  wpm: number
  accuracy: number
  peakBurstWpm: number
  rhythm: number | null
  acquisitionMs: number | null
  slowest: TransitionStat[]
}

const ARCHETYPES: Record<EnemyKind, { band: Band; speed: number; scoreMultiplier: number }> = {
  drone: { band: 'medium', speed: 34, scoreMultiplier: 1 },
  swarm: { band: 'short', speed: 52, scoreMultiplier: 1.2 },
  tank: { band: 'long', speed: 20, scoreMultiplier: 1.5 },
}

const STARTING_LIVES = 3
const RAMP_MS = 240000

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * One run of the mechanics sandbox.
 *
 * The session owns the world simulation and the typing telemetry, but it never
 * touches the DOM. Rendering reads from it, and input is pushed into it.
 */
export class RunSession {
  phase: Phase = 'title'
  enemies: Enemy[] = []
  beams: Beam[] = []
  lockedId: string | null = null
  prefix = ''
  lives = STARTING_LIVES
  score = 0
  kills = 0
  elapsedMs = 0
  lastErrorAtMs = -Infinity
  lastHitAtMs = -Infinity

  private rng: Rng = createRng(1)
  private recorder: EventRecorder = createRecorder('idle')
  private transitions = new TransitionTable()
  private nextEnemyId = 1
  private spawnTimerMs = 0
  private nowMs = 0

  private prefixTimesMs: number[] = []
  private wordTimesMs: number[] = []
  private wordKeys: string[] = []
  private readyAtMs = 0

  private keysCorrect = 0
  private keysTotal = 0
  private completedChars = 0
  private peakBurstWpm = 0
  private rhythmSamples: number[] = []
  private acquisitionSamples: number[] = []

  private summary: RunSummary | null = null

  start(nowMs: number, seed = Math.floor(Math.random() * 2 ** 31)): void {
    this.rng = createRng(seed)
    this.recorder = createRecorder(`run-${seed}`)
    this.transitions = new TransitionTable()

    this.phase = 'playing'
    this.enemies = []
    this.beams = []
    this.lockedId = null
    this.prefix = ''
    this.lives = STARTING_LIVES
    this.score = 0
    this.kills = 0
    this.elapsedMs = 0
    this.lastErrorAtMs = -Infinity
    this.lastHitAtMs = -Infinity

    this.nextEnemyId = 1
    this.spawnTimerMs = 900
    this.nowMs = nowMs
    this.readyAtMs = nowMs

    this.prefixTimesMs = []
    this.wordTimesMs = []
    this.wordKeys = []

    this.keysCorrect = 0
    this.keysTotal = 0
    this.completedChars = 0
    this.peakBurstWpm = 0
    this.rhythmSamples = []
    this.acquisitionSamples = []
    this.summary = null
  }

  /** Advance the world. `dtMs` is already clamped by the caller. */
  update(nowMs: number, dtMs: number): void {
    this.nowMs = nowMs
    this.beams = this.beams.filter((b) => b.untilMs > nowMs)
    if (this.phase !== 'playing') return

    // Elapsed time accumulates from frame deltas rather than wall clock, so a
    // backgrounded tab does not count as time spent playing.
    this.elapsedMs += dtMs
    const dtSeconds = dtMs / 1000
    const ramp = clamp01(this.elapsedMs / RAMP_MS)
    const speedScale = 1 + ramp * 1.2

    for (const enemy of this.enemies) enemy.y += enemy.speed * speedScale * dtSeconds

    const breached = this.enemies.filter((e) => e.y >= BASELINE_Y)
    if (breached.length > 0) {
      this.enemies = this.enemies.filter((e) => e.y < BASELINE_Y)
      for (const enemy of breached) {
        this.lives -= 1
        if (enemy.id === this.lockedId) this.cancelLock()
      }
      this.lastErrorAtMs = nowMs
      if (this.lives <= 0) {
        this.endRun()
        return
      }
    }

    this.spawnTimerMs -= dtMs
    if (this.spawnTimerMs <= 0) {
      this.spawn(ramp)
      const interval = lerp(1700, 620, ramp)
      this.spawnTimerMs = interval * this.rng.range(0.8, 1.2)
    }
  }

  /** Handle one printable character. */
  key(char: string, nowMs: number): void {
    if (this.phase !== 'playing') return

    const pressure = this.pressure()
    const locked = this.lockedEnemy()

    if (locked) {
      this.keysTotal += 1
      this.applyLockedKey(locked, char, nowMs, pressure)
      return
    }

    // Aiming at a word that has not dropped into the arena yet is a timing
    // guess, not a mistake, so the keystroke is ignored instead of charged as
    // an error. Without this, hiding unrevealed enemies would just trade one
    // phantom error for another.
    if (this.matchesOnlyUnrevealed(this.prefix + char)) return

    this.keysTotal += 1
    const result = resolveUnlockedKey(
      this.targets().map((e) => ({ id: e.id, sequence: e.word })),
      this.prefix,
      char,
    )

    if (result.kind === 'miss') {
      this.prefix = ''
      this.prefixTimesMs = []
      this.lastErrorAtMs = nowMs
      this.recorder.record({
        timestampMs: nowMs,
        key: char,
        code: char,
        sequenceId: null,
        expectedChar: null,
        correct: false,
        charIndex: null,
        previousCorrectKey: null,
        targetId: null,
        locked: false,
        pressure,
      })
      return
    }

    this.keysCorrect += 1

    if (result.kind === 'ambiguous') {
      this.prefix = result.prefix
      this.prefixTimesMs.push(nowMs)
      this.recorder.record({
        timestampMs: nowMs,
        key: char,
        code: char,
        sequenceId: null,
        expectedChar: char,
        correct: true,
        charIndex: result.prefix.length - 1,
        previousCorrectKey: this.prefix.length > 1 ? this.prefix[this.prefix.length - 2]! : null,
        targetId: null,
        locked: false,
        pressure,
      })
      return
    }

    const enemy = this.enemies.find((e) => e.id === result.targetId)
    if (!enemy) return

    this.lockedId = enemy.id
    enemy.typed = result.typed
    this.wordKeys = result.prefix.split('')
    this.wordTimesMs = [...this.prefixTimesMs, nowMs]
    this.prefix = ''
    this.prefixTimesMs = []
    this.lastHitAtMs = nowMs
    this.beams.push({ x: enemy.x, y: enemy.y, untilMs: nowMs + 90 })

    this.recorder.record({
      timestampMs: nowMs,
      key: char,
      code: char,
      sequenceId: enemy.word,
      expectedChar: char,
      correct: true,
      charIndex: result.typed - 1,
      previousCorrectKey: result.typed > 1 ? result.prefix[result.typed - 2]! : null,
      targetId: enemy.id,
      locked: true,
      pressure,
    })

    if (enemy.typed >= enemy.word.length) this.completeWord(enemy, nowMs)
  }

  /** Escape releases the lock without destroying progress on other targets. */
  cancelLock(): void {
    const enemy = this.lockedEnemy()
    if (enemy) enemy.typed = 0
    this.lockedId = null
    this.prefix = ''
    this.prefixTimesMs = []
    this.wordTimesMs = []
    this.wordKeys = []
  }

  lockedEnemy(): Enemy | null {
    if (this.lockedId === null) return null
    return this.enemies.find((e) => e.id === this.lockedId) ?? null
  }

  /** Enemies the player can actually read, and therefore target. */
  targets(): Enemy[] {
    return this.enemies.filter((e) => e.y >= REVEAL_Y)
  }

  private matchesOnlyUnrevealed(prefix: string): boolean {
    if (this.enemies.some((e) => e.y >= REVEAL_Y && e.word.startsWith(prefix))) return false
    return this.enemies.some((e) => e.y < REVEAL_Y && e.word.startsWith(prefix))
  }

  /** Coarse pressure estimate in [0, 1], used for telemetry and later for the director. */
  pressure(): number {
    if (this.enemies.length === 0) return 0
    const density = clamp01(this.enemies.length / 7)
    let nearest = 0
    for (const enemy of this.enemies) nearest = Math.max(nearest, enemy.y / BASELINE_Y)
    return clamp01(0.5 * density + 0.5 * clamp01(nearest))
  }

  liveWpm(): number {
    return wordsPerMinute(this.completedChars, this.elapsedMs)
  }

  currentSummary(): RunSummary | null {
    return this.summary
  }

  eventCount(): number {
    return this.recorder.count()
  }

  private applyLockedKey(enemy: Enemy, char: string, nowMs: number, pressure: number): void {
    const result = resolveLockedKey(enemy.word, enemy.typed, char)
    const previousKey = this.wordKeys[this.wordKeys.length - 1] ?? null
    const previousTime = this.wordTimesMs[this.wordTimesMs.length - 1]

    if (result.kind === 'wrong') {
      this.lastErrorAtMs = nowMs
      if (previousKey !== null && result.expected !== '') {
        this.transitions.observe(previousKey, result.expected, 0, false)
      }
      this.recorder.record({
        timestampMs: nowMs,
        key: char,
        code: char,
        sequenceId: enemy.word,
        expectedChar: result.expected,
        correct: false,
        charIndex: enemy.typed,
        previousCorrectKey: previousKey,
        targetId: enemy.id,
        locked: true,
        pressure,
      })
      return
    }

    this.keysCorrect += 1
    enemy.typed = result.typed
    this.wordKeys.push(char)
    this.wordTimesMs.push(nowMs)
    this.lastHitAtMs = nowMs
    this.beams.push({ x: enemy.x, y: enemy.y, untilMs: nowMs + 90 })

    if (previousKey !== null && previousTime !== undefined) {
      this.transitions.observe(previousKey, char, nowMs - previousTime, true)
    }

    this.recorder.record({
      timestampMs: nowMs,
      key: char,
      code: char,
      sequenceId: enemy.word,
      expectedChar: char,
      correct: true,
      charIndex: result.typed - 1,
      previousCorrectKey: previousKey,
      targetId: enemy.id,
      locked: true,
      pressure,
    })

    if (result.complete) this.completeWord(enemy, nowMs)
  }

  private completeWord(enemy: Enemy, nowMs: number): void {
    this.enemies = this.enemies.filter((e) => e.id !== enemy.id)
    this.lockedId = null
    this.kills += 1
    this.completedChars += enemy.word.length
    this.score += Math.round(enemy.word.length * 10 * ARCHETYPES[enemy.kind].scoreMultiplier)

    const firstKeyMs = this.wordTimesMs[0]
    const lastKeyMs = this.wordTimesMs[this.wordTimesMs.length - 1]

    if (firstKeyMs !== undefined) {
      // Acquisition latency is the gap before the word started, so it is
      // measured separately from the motor timing inside the word.
      this.acquisitionSamples.push(firstKeyMs - this.readyAtMs)
    }

    const intervals = interKeyIntervals(this.wordTimesMs)
    const rhythm = rhythmScore(intervals)
    if (rhythm !== null) this.rhythmSamples.push(rhythm)

    if (firstKeyMs !== undefined && lastKeyMs !== undefined && lastKeyMs > firstKeyMs) {
      const burst = wordsPerMinute(enemy.word.length - 1, lastKeyMs - firstKeyMs)
      this.peakBurstWpm = Math.max(this.peakBurstWpm, burst)
    }

    this.readyAtMs = nowMs
    this.wordTimesMs = []
    this.wordKeys = []
  }

  private spawn(ramp: number): void {
    const kind = this.chooseKind()
    const count = kind === 'swarm' ? 2 + this.rng.int(2) : 1

    for (let i = 0; i < count; i++) {
      const active = new Set(this.enemies.map((e) => e.word))
      const archetype = ARCHETYPES[kind]
      const word = pickWord(archetype.band, this.rng, active)

      this.enemies.push({
        id: `e${this.nextEnemyId++}`,
        word,
        kind,
        x: this.rng.range(120, ARENA_WIDTH - 120),
        y: -20 - i * 46,
        speed: archetype.speed * this.rng.range(0.9, 1.1) * (1 + ramp * 0.1),
        typed: 0,
        spawnedAtMs: this.nowMs,
      })
    }
  }

  private chooseKind(): EnemyKind {
    if (this.elapsedMs < 25000) return 'drone'
    const roll = this.rng.next()
    if (this.elapsedMs > 60000 && roll < 0.18) return 'tank'
    if (roll < 0.55) return 'swarm'
    return 'drone'
  }

  private endRun(): void {
    this.phase = 'over'
    this.lives = 0
    this.cancelLock()
    this.summary = {
      score: this.score,
      timeMs: this.elapsedMs,
      kills: this.kills,
      wpm: wordsPerMinute(this.completedChars, this.elapsedMs),
      accuracy: accuracy(this.keysCorrect, this.keysTotal),
      peakBurstWpm: this.peakBurstWpm,
      rhythm: this.rhythmSamples.length > 0 ? mean(this.rhythmSamples) : null,
      acquisitionMs: this.acquisitionSamples.length > 0 ? mean(this.acquisitionSamples) : null,
      slowest: this.transitions.slowest(5, 4),
    }
  }
}
