/**
 * Combo, the reward channel for typing quality.
 *
 * Gain per completed word is A^gamma * S^beta * R^rho, following section 6 of
 * the game design: A is recent accuracy, S is speed against the player's own
 * baseline, and R is the rhythm score. All three are measured over a rolling
 * window of recent words, so one word neither makes nor breaks a combo.
 *
 * Speed is relative on purpose. A slow typist typing cleanly earns the same
 * combo as a fast one, which is what stops the mechanic from collapsing into a
 * words-per-minute contest.
 *
 * None of this is shown to the player. The player sees a coarse tier and is
 * meant to feel that clean typing is powerful.
 */

export type ComboTier = 'flat' | 'warm' | 'hot' | 'peak'

/** The three channels of the gain formula, each already aggregated. */
export interface ComboComponents {
  /** Correct keys over all keys in the window, in [0, 1]. */
  accuracy: number
  /** Window speed divided by the player's own baseline. */
  speedRatio: number
  /** Rhythm score in (0, 1], as produced by `rhythmScore`. */
  rhythm: number
}

/** One completed word, as the tracker needs to see it. */
export interface WordOutcome {
  /** Characters in the sequence. */
  chars: number
  /** First key to last key of the word, in milliseconds. */
  durationMs: number
  /** Correct keys since the previous completed word. */
  correctKeys: number
  /**
   * All keys since the previous completed word. Keys spent on a target the
   * player abandoned belong here too: they were real keystrokes.
   */
  totalKeys: number
  /** Within-word rhythm score, or null when the word was too short to score. */
  rhythm: number | null
}

export interface ComboOptions {
  /** Exponent on recent accuracy. The largest of the three, on purpose. */
  accuracyExponent?: number
  /** Exponent on speed against the player's own baseline. */
  speedExponent?: number
  /** Exponent on rhythm. The smallest, because rhythm is a prototype metric. */
  rhythmExponent?: number
  /** Completed words held in the rolling window. */
  windowWords?: number
  /** Baseline assumed before the player has one, in characters per minute. */
  initialBaselineCpm?: number
  /**
   * True when `initialBaselineCpm` came from a stored profile rather than from
   * the default prior. A real baseline is not warm-started away by the first
   * word. This is the seam milestone 2 persistence plugs into.
   */
  seededBaseline?: boolean
  /** Weight of the newest word in the baseline estimate. */
  baselineEta?: number
  /** Floor on the baseline, so a stalled estimate cannot inflate the ratio. */
  minBaselineCpm?: number
  /** Floor on the speed ratio. */
  minSpeedRatio?: number
  /** Ceiling on the speed ratio, and therefore on a single word's gain. */
  maxSpeedRatio?: number
  /** Rhythm assumed when no word in the window was long enough to score. */
  neutralRhythm?: number
  /** Fraction of the combo that survives one error. */
  errorRetention?: number
  /** Ceiling on the accumulated combo. */
  maxValue?: number
  /** Ascending tier boundaries. One fewer than the number of tiers. */
  tierThresholds?: readonly number[]
  /** A tier is only given up below this fraction of the boundary that won it. */
  tierHysteresis?: number
}

type ComboConfig = Required<ComboOptions>

const TIERS: readonly ComboTier[] = ['flat', 'warm', 'hot', 'peak']

function resolve(options: ComboOptions): ComboConfig {
  return {
    accuracyExponent: options.accuracyExponent ?? 2,
    speedExponent: options.speedExponent ?? 1,
    rhythmExponent: options.rhythmExponent ?? 0.6,
    windowWords: Math.max(1, options.windowWords ?? 8),
    initialBaselineCpm: options.initialBaselineCpm ?? 200,
    seededBaseline: options.seededBaseline ?? false,
    baselineEta: options.baselineEta ?? 0.05,
    minBaselineCpm: options.minBaselineCpm ?? 60,
    minSpeedRatio: options.minSpeedRatio ?? 0.5,
    maxSpeedRatio: options.maxSpeedRatio ?? 1.6,
    neutralRhythm: options.neutralRhythm ?? 0.75,
    errorRetention: options.errorRetention ?? 0.5,
    maxValue: options.maxValue ?? 40,
    tierThresholds: options.tierThresholds ?? [4, 10, 20],
    tierHysteresis: options.tierHysteresis ?? 0.8,
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/** A word only prices speed when it has an interval to measure. */
function isTimed(word: WordOutcome): boolean {
  return word.chars > 1 && word.durationMs > 0 && Number.isFinite(word.durationMs)
}

/**
 * Characters per minute for one word. The timed span covers the gaps between
 * keys, so it prices `chars - 1`, the same convention the burst measurement in
 * the game layer uses.
 */
function wordCpm(word: WordOutcome): number | null {
  if (!isTimed(word)) return null
  return (word.chars - 1) / (word.durationMs / 60000)
}

/**
 * One word's contribution to the combo.
 *
 * The exponents rank the three channels. Accuracy is squared, so losing ten
 * percent of it costs more than losing ten percent of anything else, which is
 * how "accuracy before reckless speed" is stated in arithmetic rather than as a
 * rule. The speed ratio is clamped at both ends, so no single fast word, and no
 * misbehaving clock, can produce an unbounded reward.
 */
export function comboGain(components: ComboComponents, options: ComboOptions = {}): number {
  const config = resolve(options)
  const a = clamp(components.accuracy, 0, 1)
  const s = clamp(components.speedRatio, config.minSpeedRatio, config.maxSpeedRatio)
  const r = clamp(components.rhythm, 0, 1)
  return a ** config.accuracyExponent * s ** config.speedExponent * r ** config.rhythmExponent
}

export class ComboTracker {
  private readonly config: ComboConfig
  private readonly window: WordOutcome[] = []
  private baseline: number
  private timedWords: number
  private current = 0
  private tierIndex = 0
  private gain = 0

  constructor(options: ComboOptions = {}) {
    this.config = resolve(options)
    this.baseline = Math.max(this.config.minBaselineCpm, this.config.initialBaselineCpm)
    // A seeded baseline already carries the weight of a full history, so it
    // enters at the settled learning rate instead of the warm-start one.
    this.timedWords = this.config.seededBaseline ? Math.round(1 / this.config.baselineEta) : 0
  }

  /** Accumulated combo. */
  value(): number {
    return this.current
  }

  /** The coarse band the game may show. The number behind it stays hidden. */
  tier(): ComboTier {
    return TIERS[this.tierIndex] ?? 'flat'
  }

  /** Gain of the most recent completed word. */
  lastGain(): number {
    return this.gain
  }

  /**
   * The player's own speed baseline, in characters per minute.
   *
   * Within one run this is bootstrapped from the run itself. Milestone 2 can
   * persist it and hand it back through `initialBaselineCpm`, which is the only
   * change that seam needs.
   */
  baselineCpm(): number {
    return this.baseline
  }

  /** Window aggregates. For telemetry and tests, never for display. */
  components(): ComboComponents {
    let correct = 0
    let total = 0
    let spanChars = 0
    let spanMs = 0
    let rhythmTotal = 0
    let rhythmCount = 0

    for (const word of this.window) {
      correct += word.correctKeys
      total += word.totalKeys
      if (isTimed(word)) {
        spanChars += word.chars - 1
        spanMs += word.durationMs
      }
      if (word.rhythm !== null) {
        rhythmTotal += word.rhythm
        rhythmCount += 1
      }
    }

    // Until the player has been measured, speed is neutral. Judging the first
    // words of a run against a prior nobody chose is what biased combo for
    // anyone whose real pace was far from it.
    const measured = this.timedWords > 0 && spanMs > 0

    return {
      accuracy: total > 0 ? correct / total : 1,
      speedRatio: measured ? spanChars / (spanMs / 60000) / this.baseline : 1,
      rhythm: rhythmCount > 0 ? rhythmTotal / rhythmCount : this.config.neutralRhythm,
    }
  }

  /**
   * Feed one completed word and return its gain.
   *
   * The baseline is updated after the gain is computed, so a word is measured
   * against the player the game knew before they typed it. The baseline also
   * moves far more slowly than the window: if both tracked the same handful of
   * words, the ratio would sit at one forever and speed would carry no signal.
   */
  completeWord(outcome: WordOutcome): number {
    this.window.push(outcome)
    if (this.window.length > this.config.windowWords) this.window.shift()

    this.gain = comboGain(this.components(), this.config)
    this.current = Math.min(this.config.maxValue, this.current + this.gain)

    const cpm = wordCpm(outcome)
    if (cpm !== null) {
      // The learning rate starts at one and decays to the configured value, so
      // the first measured word replaces the prior outright and the estimate is
      // the running mean until it has enough history to settle. Without this a
      // short run never escapes the prior at all.
      this.timedWords += 1
      const eta = Math.max(this.config.baselineEta, 1 / this.timedWords)
      const next = this.baseline + eta * (cpm - this.baseline)
      this.baseline = Math.max(this.config.minBaselineCpm, next)
    }

    this.settleTier()
    return this.gain
  }

  /**
   * A wrong key, or a breach.
   *
   * The drop is immediate, and the same mistake is charged again, far more
   * gently, through recent accuracy over the next few words. That is
   * deliberate: one is felt as a loss, the other as a recovery. A full reset
   * would make every long word a gamble, which punishes the player for trying
   * rather than for being careless.
   */
  registerError(): void {
    this.current *= this.config.errorRetention
    if (this.current < 0.01) this.current = 0
    this.settleTier()
  }

  /**
   * Tiers are sticky. A value hovering on a boundary would otherwise flicker
   * once per word, which reads as noise rather than as progress.
   */
  private settleTier(): void {
    const bounds = this.config.tierThresholds
    const top = Math.min(bounds.length, TIERS.length - 1)
    let index = Math.min(this.tierIndex, top)

    while (index < top && this.current >= bounds[index]!) index += 1
    while (index > 0 && this.current < bounds[index - 1]! * this.config.tierHysteresis) index -= 1

    this.tierIndex = index
  }
}
