import {
  type ComboTier,
  type ErrorPolicy,
  type EventRecorder,
  type TransitionStat,
  ComboTracker,
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
import { Director } from './director'
import { type Rng, createRng } from './rng'
import { wordScore } from './scoring'

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

/** Where the player sits. Beams leave from here and misses land here. */
export const PLAYER_X = ARENA_WIDTH / 2
export const PLAYER_Y = ARENA_HEIGHT - 48

export type Phase = 'title' | 'playing' | 'over'
export type EnemyKind = 'drone' | 'swarm' | 'tank' | 'sprinter' | 'shield'

/**
 * Something the player should see and hear about.
 *
 * The session does not know what a particle or an oscillator is, so it says
 * what happened and where, and leaves the answer to the caller. Feedback is
 * drained once per frame rather than pushed through a callback, which keeps
 * audio and effects out of the keystroke path entirely.
 */
export type FeedbackKind = 'hit' | 'miss' | 'kill' | 'breach' | 'promote'

export interface Feedback {
  kind: FeedbackKind
  /** Where in the arena it happened. */
  x: number
  y: number
  /** How far through the word it left the player, in [0, 1]. */
  progress: number
  /** The combo tier at that moment. */
  tier: ComboTier
}

/** Undrained feedback is dropped rather than accumulated. Nothing here is worth a leak. */
const FEEDBACK_LIMIT = 96

export interface Enemy {
  id: string
  word: string
  kind: EnemyKind
  x: number
  y: number
  speed: number
  typed: number
  spawnedAtMs: number
  /** When it was last struck, so the renderer can make it flinch. */
  hitAtMs: number
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

interface Archetype {
  band: Band
  speed: number
  /** What a wrong key does to progress on this enemy. */
  errorPolicy: ErrorPolicy
  /** Enemies spawned per appearance. */
  burst: number
}

/**
 * The archetypes, each asking for a different kind of typing.
 *
 * Sprinter is a short word travelling fast, so it prices reaction and burst.
 * Shield is the only one that changes the rules of a mistake: a wrong key
 * sends the whole word back to the start, which prices controlled accuracy
 * under pressure. Both come from section 3 of the game design.
 *
 * What each one is worth lives in `scoring.ts`, beside the bounds that keep
 * the spread between them small.
 */
const ARCHETYPES: Record<EnemyKind, Archetype> = {
  drone: { band: 'medium', speed: 34, errorPolicy: 'keep', burst: 1 },
  swarm: { band: 'short', speed: 52, errorPolicy: 'keep', burst: 3 },
  tank: { band: 'long', speed: 20, errorPolicy: 'keep', burst: 1 },
  sprinter: { band: 'short', speed: 96, errorPolicy: 'keep', burst: 1 },
  shield: { band: 'medium', speed: 26, errorPolicy: 'reset', burst: 1 },
}

const STARTING_LIVES = 3

/** Silence longer than this, with something to type, counts as idling. */
const IDLE_GRACE_MS = 900
const TIER_ORDER: readonly ComboTier[] = ['flat', 'warm', 'hot', 'peak']

/**
 * The renderer uses a fixed monospace face, so one constant advance per
 * character is accurate enough for spawn layout and keeps the session free of
 * canvas measurement.
 */
const CHAR_WIDTH = 13.2
const SPAWN_MARGIN = 40
/** Two words this close vertically read as one cluttered line. */
const STACK_BAND_Y = 140
/** Blank space demanded between two words on the same line. */
const WORD_GAP = 18
const PLACEMENT_TRIES = 6

function halfTextWidth(word: string): number {
  return (word.length * CHAR_WIDTH) / 2
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
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
  /** Set when the combo climbs a tier, so the renderer can name it briefly. */
  tierPromotedAtMs = -Infinity
  promotedTier: ComboTier | null = null

  private lastInputAtMs = 0
  private lastTier: ComboTier = 'flat'
  private feedback: Feedback[] = []
  private rng: Rng = createRng(1)
  private recorder: EventRecorder = createRecorder('idle')
  private comboTracker = new ComboTracker()
  private director = new Director()
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
  /** Run totals at the last completed word, so the combo can see per-word counts. */
  private wordStartCorrect = 0
  private wordStartTotal = 0
  private completedChars = 0
  private peakBurstWpm = 0
  private rhythmSamples: number[] = []
  private acquisitionSamples: number[] = []

  private summary: RunSummary | null = null

  start(nowMs: number, seed = Math.floor(Math.random() * 2 ** 31)): void {
    this.rng = createRng(seed)
    this.recorder = createRecorder(`run-${seed}`)
    this.transitions = new TransitionTable()
    this.comboTracker = new ComboTracker()
    this.director = new Director()

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
    this.tierPromotedAtMs = -Infinity
    this.promotedTier = null
    this.lastInputAtMs = nowMs
    this.lastTier = 'flat'
    this.feedback = []

    this.nextEnemyId = 1
    this.spawnTimerMs = 900
    this.nowMs = nowMs
    this.readyAtMs = nowMs

    this.prefixTimesMs = []
    this.wordTimesMs = []
    this.wordKeys = []

    this.keysCorrect = 0
    this.keysTotal = 0
    this.wordStartCorrect = 0
    this.wordStartTotal = 0
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
    const plan = this.director.plan()

    for (const enemy of this.enemies) enemy.y += enemy.speed * plan.speedScale * dtSeconds

    let livesLost = 0
    const breached = this.enemies.filter((e) => e.y >= BASELINE_Y)
    if (breached.length > 0) {
      this.enemies = this.enemies.filter((e) => e.y < BASELINE_Y)
      for (const enemy of breached) {
        this.lives -= 1
        livesLost += 1
        // A breach is the plainest break in flow the game has, so it costs
        // combo even though nothing was mistyped.
        this.comboTracker.registerError()
        this.emit('breach', enemy.x, BASELINE_Y, 0)
        if (enemy.id === this.lockedId) this.cancelLock(nowMs)
      }
      this.lastErrorAtMs = nowMs
      if (this.lives <= 0) {
        this.endRun()
        return
      }
    }

    this.director.update(dtMs, {
      enemies: this.enemies.length,
      nearestProgress: this.nearestProgress(),
      livesLost,
    })

    // Dropped before spawning, so a dead prefix cannot silently attach itself
    // to a word that appears in the same tick.
    this.dropStalePrefix()

    // Combo bleeds only when there is something readable to type and the
    // player is not typing it. The lull before anything has fallen into the
    // arena is the game's pacing, not the player standing still.
    if (this.targets().length > 0 && nowMs - this.lastInputAtMs > IDLE_GRACE_MS) {
      this.comboTracker.decay(dtMs)
    }

    this.spawnTimerMs -= dtMs
    if (this.spawnTimerMs <= 0) {
      this.spawn()
      this.spawnTimerMs = plan.intervalMs * this.rng.range(0.8, 1.2)
    }

    this.noteTierChange(nowMs)
  }

  /** Records a climb so the renderer can name the new tier for a moment. */
  private noteTierChange(nowMs: number): void {
    const tier = this.comboTracker.tier()
    if (tier === this.lastTier) return

    if (TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(this.lastTier)) {
      this.promotedTier = tier
      this.tierPromotedAtMs = nowMs
      this.emit('promote', PLAYER_X, PLAYER_Y, 1)
    }
    this.lastTier = tier
  }

  private emit(kind: FeedbackKind, x: number, y: number, progress: number): void {
    if (this.feedback.length >= FEEDBACK_LIMIT) this.feedback.shift()
    this.feedback.push({ kind, x, y, progress, tier: this.comboTracker.tier() })
  }

  /**
   * Takes everything that has happened since the last call.
   *
   * Draining rather than reading keeps the caller honest: a frame that skips
   * the queue drops the events instead of replaying them late, and stale
   * feedback is worse than none.
   */
  drainFeedback(): Feedback[] {
    if (this.feedback.length === 0) return []
    const events = this.feedback
    this.feedback = []
    return events
  }

  /** Handle one printable character. */
  key(char: string, nowMs: number): void {
    if (this.phase !== 'playing') return

    // Any keypress counts as engagement, including a reflex space. Only
    // silence is idling.
    this.lastInputAtMs = nowMs
    const pressure = this.pressure()
    const locked = this.lockedEnemy()

    // No word in the corpus contains a space, so a space between words is a
    // typing habit rather than a mistake. It costs nothing, but it is kept in
    // the event stream because reflex spacing is a real motor pattern the
    // skill model will want later. Events with key ' ' are exactly these.
    if (char === ' ') {
      this.recorder.record({
        timestampMs: nowMs,
        key: char,
        code: 'Space',
        sequenceId: locked?.word ?? null,
        expectedChar: null,
        correct: false,
        charIndex: null,
        previousCorrectKey: this.wordKeys[this.wordKeys.length - 1] ?? null,
        targetId: locked?.id ?? null,
        locked: locked !== null,
        pressure,
      })
      return
    }

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
      this.comboTracker.registerError()
      this.emit('miss', PLAYER_X, PLAYER_Y, 0)
      // The miss ends the current measurement window along with the prefix, so
      // it is charged here and not again in the next word's accuracy.
      this.beginWordWindow()
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
    enemy.hitAtMs = nowMs
    this.beams.push({ x: enemy.x, y: enemy.y, untilMs: nowMs + 90 })
    this.emit('hit', enemy.x, enemy.y, result.typed / enemy.word.length)

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

  /**
   * Escape releases the lock without destroying progress on other targets.
   *
   * The acquisition clock restarts here. Time spent on a word the player
   * abandoned is not time spent finding the next one, and charging it to the
   * next word's acquisition latency would make that measurement meaningless.
   * The frame clock is deliberately left alone, since only `update` may
   * advance it.
   */
  cancelLock(nowMs = this.nowMs): void {
    const enemy = this.lockedEnemy()
    if (enemy) enemy.typed = 0
    this.lockedId = null
    this.prefix = ''
    this.prefixTimesMs = []
    this.readyAtMs = nowMs
    this.beginWordWindow()
  }

  lockedEnemy(): Enemy | null {
    if (this.lockedId === null) return null
    return this.enemies.find((e) => e.id === this.lockedId) ?? null
  }

  /** Enemies the player can actually read, and therefore target. */
  targets(): Enemy[] {
    return this.enemies.filter((e) => e.y >= REVEAL_Y)
  }

  /**
   * Forgets a prefix whose targets are all gone.
   *
   * Type `t` while `travel` and `traffic` are up, let both breach, and the
   * next keystroke would otherwise be charged as a miss against words that no
   * longer exist.
   */
  private dropStalePrefix(): void {
    if (this.prefix === '' || this.lockedId !== null) return
    if (this.targets().some((e) => e.word.startsWith(this.prefix))) return

    this.prefix = ''
    this.prefixTimesMs = []
  }

  private matchesOnlyUnrevealed(prefix: string): boolean {
    if (this.enemies.some((e) => e.y >= REVEAL_Y && e.word.startsWith(prefix))) return false
    return this.enemies.some((e) => e.y < REVEAL_Y && e.word.startsWith(prefix))
  }

  /** Coarse pressure estimate in [0, 1], recorded on every keystroke. */
  pressure(): number {
    return this.director.currentPressure()
  }

  /** The director's dial, for tests and telemetry. Never shown to the player. */
  intensity(): number {
    return this.director.level()
  }

  /** How far the nearest enemy has fallen toward the baseline, in [0, 1]. */
  private nearestProgress(): number {
    let nearest = 0
    for (const enemy of this.enemies) nearest = Math.max(nearest, enemy.y / BASELINE_Y)
    return clamp01(nearest)
  }

  liveWpm(): number {
    return wordsPerMinute(this.completedChars, this.elapsedMs)
  }

  /**
   * Accumulated combo, and the coarse tier a HUD may show.
   *
   * The formula behind the number is never shown to the player. What the player
   * is meant to feel is that clean typing is powerful.
   */
  combo(): number {
    return this.comboTracker.value()
  }

  comboTier(): ComboTier {
    return this.comboTracker.tier()
  }

  currentSummary(): RunSummary | null {
    return this.summary
  }

  eventCount(): number {
    return this.recorder.count()
  }

  private applyLockedKey(enemy: Enemy, char: string, nowMs: number, pressure: number): void {
    const policy = ARCHETYPES[enemy.kind].errorPolicy
    const result = resolveLockedKey(enemy.word, enemy.typed, char, policy)
    const previousKey = this.wordKeys[this.wordKeys.length - 1] ?? null
    const previousTime = this.wordTimesMs[this.wordTimesMs.length - 1]

    if (result.kind === 'wrong') {
      this.lastErrorAtMs = nowMs
      this.comboTracker.registerError()
      this.emit('miss', enemy.x, enemy.y, result.typed / enemy.word.length)
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

      const lost = enemy.typed - result.typed
      enemy.typed = result.typed
      // A shield that swallowed the whole word starts the measurement over
      // with it, so the abandoned attempt is not charged to the retry.
      if (lost > 0) this.beginWordWindow()
      return
    }

    this.keysCorrect += 1
    enemy.typed = result.typed
    this.wordKeys.push(char)
    this.wordTimesMs.push(nowMs)
    this.lastHitAtMs = nowMs
    enemy.hitAtMs = nowMs
    this.beams.push({ x: enemy.x, y: enemy.y, untilMs: nowMs + 90 })
    this.emit('hit', enemy.x, enemy.y, result.typed / enemy.word.length)

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
    this.emit('kill', enemy.x, enemy.y, 1)
    this.completedChars += enemy.word.length

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

    this.comboTracker.completeWord({
      chars: enemy.word.length,
      durationMs:
        firstKeyMs === undefined || lastKeyMs === undefined ? 0 : lastKeyMs - firstKeyMs,
      correctKeys: this.keysCorrect - this.wordStartCorrect,
      totalKeys: this.keysTotal - this.wordStartTotal,
      rhythm,
    })

    // Scored after the combo has seen the word, so the word the player just
    // typed is priced with itself included rather than a word behind.
    const quality = this.comboTracker.components()
    this.score += wordScore({
      chars: enemy.word.length,
      kind: enemy.kind,
      intensity: this.director.level(),
      comboFraction: this.comboTracker.progress(),
      accuracy: quality.accuracy,
      rhythm: quality.rhythm,
    })

    this.readyAtMs = nowMs
    this.beginWordWindow()
  }

  /**
   * Starts a fresh per-word measurement window.
   *
   * Key counts and timing have to start together. When they did not, keys
   * spent on a word the player abandoned landed in the next word's accuracy
   * while contributing none of its time, so a recovered word was judged fast
   * and sloppy at once. Those keys are still charged, immediately and once,
   * through `registerError`.
   */
  private beginWordWindow(): void {
    this.wordTimesMs = []
    this.wordKeys = []
    this.wordStartCorrect = this.keysCorrect
    this.wordStartTotal = this.keysTotal
  }

  private spawn(): void {
    const kind = this.chooseKind()
    const archetype = ARCHETYPES[kind]
    // A swarm arrives as a cluster of two or three, the rest one at a time.
    const count = archetype.burst > 1 ? archetype.burst - this.rng.int(2) : 1

    for (let i = 0; i < count; i++) {
      const active = new Set(this.enemies.map((e) => e.word))
      const word = pickWord(archetype.band, this.rng, active)

      const y = -20 - i * 46

      this.enemies.push({
        id: `e${this.nextEnemyId++}`,
        word,
        kind,
        x: this.placeX(word, y),
        y,
        speed: archetype.speed * this.rng.range(0.9, 1.1),
        typed: 0,
        spawnedAtMs: this.nowMs,
        hitAtMs: -Infinity,
      })
    }
  }

  /**
   * Picks a horizontal slot for a new word.
   *
   * A single unconstrained draw lets a long word land on top of a neighbour,
   * and an unreadable word is an unfair target rather than a hard one. This
   * takes the first candidate that clears every word in the same vertical
   * band, and otherwise the roomiest one it saw.
   */
  private placeX(word: string, y: number): number {
    const half = halfTextWidth(word)
    const min = SPAWN_MARGIN + half
    const max = ARENA_WIDTH - SPAWN_MARGIN - half
    if (max <= min) return ARENA_WIDTH / 2

    const neighbours = this.enemies.filter((e) => Math.abs(e.y - y) < STACK_BAND_Y)
    let best = this.rng.range(min, max)
    let bestGap = -Infinity

    for (let attempt = 0; attempt < PLACEMENT_TRIES; attempt++) {
      const x = attempt === 0 ? best : this.rng.range(min, max)
      let gap = Infinity
      for (const other of neighbours) {
        const needed = half + halfTextWidth(other.word) + WORD_GAP
        gap = Math.min(gap, Math.abs(other.x - x) - needed)
      }
      if (gap > bestGap) {
        bestGap = gap
        best = x
      }
      if (gap >= 0) break
    }

    return best
  }

  /**
   * Draws an archetype from the director's weights.
   *
   * The session no longer decides what the run is made of. It only rolls the
   * dice the director hands it, which is what keeps composition and pacing in
   * one place instead of spread across elapsed-time thresholds.
   */
  private chooseKind(): EnemyKind {
    const weights = this.director.plan().weights
    const entries = Object.entries(weights) as [EnemyKind, number][]

    let total = 0
    for (const [, weight] of entries) total += weight
    if (total <= 0) return 'drone'

    let roll = this.rng.next() * total
    for (const [kind, weight] of entries) {
      roll -= weight
      if (roll <= 0) return kind
    }
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
