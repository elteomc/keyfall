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
  /** How long the pressure reading has sat outside the band, signed. */
  private heldMs = 0

  update(dtMs: number, signals: DirectorSignals): void {
    if (dtMs <= 0) return

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

  /**
   * How hard the player is being pushed right now.
   *
   * Crowding and proximity only. Skill signals are deliberately absent: the
   * player's own speed and accuracy already show up here, as an arena that
   * empties out.
   */
  private readPressure(signals: DirectorSignals): number {
    const density = clamp01(signals.enemies / 7)
    return clamp01(0.5 * density + 0.5 * clamp01(signals.nearestProgress))
  }
}
