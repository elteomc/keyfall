import type { EnemyKind } from './session'

/**
 * The difficulty director.
 *
 * Everything the run throws at the player hangs off one dial, `intensity` in
 * [0, 1]. The director reads how hard the player is currently being pushed,
 * compares it to a target band, and turns the dial toward the band.
 *
 * Section 8 of the game design is emphatic about how it must not behave: it
 * must not immediately counter good performance. So the dial has all three of
 * the brakes named there.
 *
 * - A deadband. Inside the target band nothing moves at all, which is the
 *   hysteresis: the director is not forever chasing the last keystroke.
 * - Lag. A reading has to persist for `LAG_MS` before the dial responds, so a
 *   single cleared wave does not read as mastery.
 * - A capped rate. The dial moves by at most so much per second, and it eases
 *   off roughly twice as fast as it bears down. A player in trouble gets help
 *   sooner than a player in flow gets punished.
 *
 * The result is that a run of brilliant play buys real time at low pressure
 * before the game answers it, which is the whole point.
 */

export interface DirectorSignals {
  /** Enemies currently in the arena. */
  enemies: number
  /** How far the nearest enemy has fallen toward the baseline, in [0, 1]. */
  nearestProgress: number
  /** Lives lost since the last update. */
  livesLost: number
  /** Characters that entered the arena since the last update. */
  charsArrived: number
  /** The player's own typing speed, in characters per minute. */
  capacityCpm: number
}

export interface SpawnPlan {
  intervalMs: number
  speedScale: number
  weights: Partial<Record<EnemyKind, number>>
}

/** Below this the player is coasting, above it they are drowning. */
const BAND_LOW = 0.3
const BAND_HIGH = 0.6

/** How long a reading must hold before the dial answers it. */
const LAG_MS = 2500

/**
 * Ceiling on how fast the dial may turn, per second.
 *
 * At this rate a player who coasts through everything still needs well over a
 * minute to reach the top, which is roughly the calibration and expansion
 * window the run structure in section 9 asks for. Relief is a little over
 * twice as fast as escalation.
 */
const RISE_PER_SECOND = 0.01
const FALL_PER_SECOND = 0.022

/** A life lost is unambiguous, so it is relieved without waiting out the lag. */
const BREACH_RELIEF = 0.08

/**
 * Time constant of the arrival-rate estimate.
 *
 * Long enough that one burst of swarm does not read as a permanent flood,
 * short enough to follow the run.
 */
const ARRIVAL_TAU_MS = 9000

/** A baseline below this is a measurement artefact, not a slow typist. */
const MIN_CAPACITY_CPM = 60

/**
 * The load range the target band stands for.
 *
 * Load is arrivals against the player's own measured speed, and these two
 * numbers say what share of it the arena should be spending. Below `LOW` the
 * player has slack and the dial climbs. Above `TOP` they are drowning and it
 * eases off.
 *
 * Both ends have now been wrong once, and the second time was worse.
 *
 * The first version fed load into the band raw, so the band stood for 30 to 60
 * percent of the player's speed and the dial could never ask for more. The fix
 * scaled the top of the band to a load near 1.0 and stopped there, which
 * silently left the *floor* at 0.475. The dial was therefore content anywhere
 * between 48 and 95 percent, a deadband spanning half of what the player could
 * do.
 *
 * Measured on a real profile, that parked the dial at zero for nine minutes:
 * arrivals settled at 51 percent of measured speed, which sat just inside the
 * deadband, so nothing ever escalated. The whole run was drones, because every
 * other archetype unlocks above intensity zero.
 *
 * Mapping both ends explicitly is what stops one of them drifting out of sight
 * again.
 */
const LOAD_AT_BAND_LOW = 0.7
const LOAD_AT_BAND_TOP = 0.95

/**
 * Intensity at which each archetype starts appearing.
 *
 * This replaces the fixed elapsed-time thresholds the session used to carry.
 * A player who is struggling never meets a shield, and a player in flow meets
 * one sooner than the clock would have allowed.
 */
const UNLOCK: Record<EnemyKind, number> = {
  drone: 0,
  swarm: 0.15,
  tank: 0.3,
  sprinter: 0.38,
  shield: 0.55,
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export class Director {
  private intensity = 0
  private pressure = 0
  private load = 0
  /** How long the pressure reading has sat outside the band, signed. */
  private heldMs = 0
  private arrivalChars = 0
  private arrivalWindowMs = 0

  update(dtMs: number, signals: DirectorSignals): void {
    if (dtMs <= 0) return

    this.trackArrivals(dtMs, signals.charsArrived)
    this.pressure = this.readPressure(signals)

    if (signals.livesLost > 0) {
      this.intensity = clamp01(this.intensity - BREACH_RELIEF * signals.livesLost)
      this.heldMs = 0
      return
    }

    const wants = this.pressure < BAND_LOW ? 1 : this.pressure > BAND_HIGH ? -1 : 0
    if (wants === 0) {
      // Inside the band the director does nothing at all. Not a small
      // correction, nothing.
      this.heldMs = 0
      return
    }

    // A reading that flips direction restarts the clock rather than carrying
    // credit over from the opposite case.
    this.heldMs = Math.sign(this.heldMs) === wants ? this.heldMs + wants * dtMs : wants * dtMs
    if (Math.abs(this.heldMs) < LAG_MS) return

    const rate = wants > 0 ? RISE_PER_SECOND : FALL_PER_SECOND
    this.intensity = clamp01(this.intensity + wants * rate * (dtMs / 1000))
  }

  /** The dial itself, for telemetry and tests. Never shown to the player. */
  level(): number {
    return this.intensity
  }

  /** The most recent pressure reading, in [0, 1]. */
  currentPressure(): number {
    return this.pressure
  }

  plan(): SpawnPlan {
    const weights: Partial<Record<EnemyKind, number>> = {}
    for (const [kind, unlock] of Object.entries(UNLOCK) as [EnemyKind, number][]) {
      if (this.intensity < unlock) continue
      // Newly unlocked archetypes fade in rather than arriving at full weight,
      // so crossing a threshold is not a step change in what the run feels like.
      weights[kind] = 0.2 + clamp01((this.intensity - unlock) * 3)
    }

    // Drones thin out as the run fills with things that are more interesting
    // to type, without ever disappearing.
    weights.drone = lerp(1.6, 0.5, this.intensity)

    return {
      intervalMs: lerp(1700, 620, this.intensity),
      speedScale: 1 + this.intensity * 1.2,
      weights,
    }
  }

  /** Share of the player's typing speed the arena is currently demanding. */
  currentLoad(): number {
    return this.load
  }

  /**
   * How hard the player is being pushed right now.
   *
   * Two readings, and the worse one wins.
   *
   * Crowding and proximity say how bad things are *now*. On their own they are
   * a lagging indicator, and dangerously so: a player clearing words as fast as
   * they arrive leaves one or two on screen whether they are working at a third
   * of their speed or at the very edge of it. Queue length stays near zero right
   * up to the moment arrivals outpace the player, and then it runs away. Steered
   * on crowding alone the dial climbed for over two minutes against a reading of
   * 0.1, and the run collapsed from two enemies to eleven in twenty seconds.
   *
   * Load is the leading indicator that fixes it: characters arriving per minute
   * against the player's own measured characters per minute. At 0.4 the arena is
   * asking for less than half of them and there is real room. Approaching 1.0 it
   * is asking for everything they have, which is the edge, and it says so before
   * the backlog exists rather than after.
   *
   * Load is scaled so that `LOAD_AT_BAND_TOP` reads as the top of the band. The
   * dial therefore holds arrivals somewhere near half to nearly all of the
   * player's measured speed, rather than the timid third-to-half it held when
   * load fed the band raw.
   *
   * This is a skill signal, which D10 deliberately excluded and D16 puts back.
   * It is not rubber-banding: nothing here reacts to *how well* the player is
   * doing, only to how much of their demonstrated speed the game is spending.
   * The deadband, the lag and the capped rate all still stand between this
   * reading and the dial.
   */
  private readPressure(signals: DirectorSignals): number {
    const density = clamp01(signals.enemies / 7)
    const crowding = clamp01(0.5 * density + 0.5 * clamp01(signals.nearestProgress))

    const capacity = Math.max(MIN_CAPACITY_CPM, signals.capacityCpm)
    this.load = this.arrivalWindowMs > 0
      ? this.arrivalChars / (this.arrivalWindowMs / 60000) / capacity
      : 0

    // Both ends of the band are anchored to a load, so the reading is a
    // straight line between them rather than a scale factor with a floor
    // nobody chose.
    const span = LOAD_AT_BAND_TOP - LOAD_AT_BAND_LOW
    const fromLoad = BAND_LOW + ((this.load - LOAD_AT_BAND_LOW) / span) * (BAND_HIGH - BAND_LOW)

    return Math.max(crowding, clamp01(fromLoad))
  }

  /**
   * Time-decayed arrival estimate.
   *
   * Both the character count and the window it covers decay together, so the
   * ratio is a rate that follows the run instead of an average over all of it.
   */
  private trackArrivals(dtMs: number, charsArrived: number): void {
    const decay = Math.exp(-dtMs / ARRIVAL_TAU_MS)
    this.arrivalChars = this.arrivalChars * decay + charsArrived
    this.arrivalWindowMs = this.arrivalWindowMs * decay + dtMs
  }
}
