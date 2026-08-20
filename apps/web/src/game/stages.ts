/**
 * The shape of a run.
 *
 * This is the one part of the game that still reads the clock, and the split
 * with the director is deliberate. The director decides how *hard* the run is,
 * from pressure alone, and D10 keeps the clock out of that entirely. The stage
 * decides only what *shape* the run has: when spawning thins for a breath, when
 * it stops for good, and therefore when the run is allowed to end.
 *
 * So difficulty still adapts to the player, and structure does not. A strong
 * player and a struggling one get the same arc, filled with different enemies.
 *
 * The boundaries follow the eight minute example in section 9 of the game
 * design. Section 21 question 8 says the right run length is something to learn
 * from play rather than to argue about, so every number lives in one table.
 */

export type RunStage = 'calibration' | 'expansion' | 'pressure' | 'lull' | 'finale'

interface StageBand {
  stage: RunStage
  /** Elapsed time at which this stage gives way to the next. */
  untilMs: number
  /** Multiplier on the director's spawn interval. Above 1 is a breath. */
  intervalScale: number
}

const BANDS: readonly StageBand[] = [
  { stage: 'calibration', untilMs: 90_000, intervalScale: 1 },
  { stage: 'expansion', untilMs: 210_000, intervalScale: 1 },
  { stage: 'pressure', untilMs: 330_000, intervalScale: 1 },
  // The lull is a real drop in arrivals rather than a pause, because a game
  // that stops entirely reads as broken rather than as a breath.
  { stage: 'lull', untilMs: 390_000, intervalScale: 2.4 },
  { stage: 'finale', untilMs: Infinity, intervalScale: 1 },
]

const LAST_BAND = BANDS[BANDS.length - 1]!

function bandAt(elapsedMs: number): StageBand {
  for (const band of BANDS) {
    if (elapsedMs < band.untilMs) return band
  }
  return LAST_BAND
}

export function stageAt(elapsedMs: number): RunStage {
  return bandAt(elapsedMs).stage
}

export function intervalScaleAt(elapsedMs: number): number {
  return bandAt(elapsedMs).intervalScale
}

/** When the closing wave arrives, and so the earliest a run can be cleared. */
export const FINALE_AT_MS = BANDS[BANDS.length - 2]!.untilMs

/**
 * How many enemies the closing wave brings.
 *
 * It scales with the director's dial so the ending is proportional to the run
 * the player actually had. Someone who never climbed out of calibration is not
 * handed a wall on the way out, and someone who spent the run at the top does
 * not get to walk through the door.
 */
export function finaleWaveSize(intensity: number): number {
  const dial = Math.min(1, Math.max(0, intensity))
  return 4 + Math.round(dial * 4)
}
