import type { EnemyKind } from './session'

/**
 * What a destroyed word is worth.
 *
 * Section 11 of the game design gives the shape,
 * `BaseKills x Difficulty x Accuracy x Flow x Combo`, and one hard rule with
 * it: the optimal strategy must never become "type only the enemy with the
 * fattest multiplier". So every factor here is bounded, and the bounds are
 * picked so the rule is arithmetic rather than a hope. Target choice moves the
 * score by at most `1.7x` end to end. Typing well moves it by about `6.8x`.
 * A player chasing archetypes while typing badly cannot out-score a player
 * typing cleanly at whatever the arena happens to send them.
 *
 * Difficulty is what the game asked of the player, quality is how well they
 * answered, and the combo is how long they have been answering well. The
 * quality channels come from the combo tracker's own rolling window, so score
 * and combo cannot drift into disagreeing about what "recent" means.
 */

export interface WordScoreInput {
  /** Characters in the destroyed word. */
  chars: number
  /** The archetype that carried it. */
  kind: EnemyKind
  /** The director's dial, in [0, 1]. */
  intensity: number
  /** Share of the combo ceiling held, in [0, 1]. */
  comboFraction: number
  /** Recent accuracy over the combo window, in [0, 1]. */
  accuracy: number
  /** Recent rhythm over the combo window, in [0, 1]. */
  rhythm: number
}

const POINTS_PER_CHAR = 10

/**
 * What each archetype asks for beyond a drone.
 *
 * The spread is deliberately narrow. A shield is genuinely harder than a
 * drone, but the reward for meeting it has to stay smaller than the reward for
 * typing well, or target selection stops being a tactical choice and becomes a
 * scoring one.
 */
const ARCHETYPE_DIFFICULTY: Record<EnemyKind, number> = {
  drone: 1,
  swarm: 1.1,
  tank: 1.25,
  sprinter: 1.3,
  shield: 1.35,
}

/** The most the director's dial can add on top of the archetype. */
const RAMP_CEILING = 1.25

/** Recent accuracy maps into this range. Zero accuracy still pays something. */
const ACCURACY_FLOOR = 0.7
const ACCURACY_CEILING = 1.1

/** Recent rhythm maps into this range, a narrower one, since it is a prototype metric. */
const FLOW_FLOOR = 0.8
const FLOW_CEILING = 1.15

/** A full combo triples the word. Nothing else in the formula comes close. */
const COMBO_CEILING = 3

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** What the game asked for: the archetype, raised by how far the run has ramped. */
export function difficultyMultiplier(kind: EnemyKind, intensity: number): number {
  return ARCHETYPE_DIFFICULTY[kind] * lerp(1, RAMP_CEILING, clamp01(intensity))
}

/** How well the player has been typing lately, accuracy weighted above flow. */
export function qualityMultiplier(accuracy: number, rhythm: number): number {
  return (
    lerp(ACCURACY_FLOOR, ACCURACY_CEILING, clamp01(accuracy)) *
    lerp(FLOW_FLOOR, FLOW_CEILING, clamp01(rhythm))
  )
}

/** How long they have been keeping it up. */
export function comboMultiplier(comboFraction: number): number {
  return lerp(1, COMBO_CEILING, clamp01(comboFraction))
}

export function wordScore(input: WordScoreInput): number {
  const base = Math.max(0, input.chars) * POINTS_PER_CHAR
  if (base <= 0) return 0

  const raw =
    base *
    difficultyMultiplier(input.kind, input.intensity) *
    qualityMultiplier(input.accuracy, input.rhythm) *
    comboMultiplier(input.comboFraction)

  // A destroyed enemy is always worth something, however badly it was typed.
  return Math.max(1, Math.round(raw))
}
