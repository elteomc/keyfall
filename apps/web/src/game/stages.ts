/**
 * The shape of a run.
 *
 * The arc used to be fixed time bands taken from section 9 of the game design,
 * with the finale at 6:30 on the clock. Playtesting killed that. A player
 * cannot see elapsed time, so a time-based arc is invisible, and the first
 * report back was that the game felt identical from start to finish. Progress
 * is the thing you actually feel.
 *
 * So the arc now advances on targets destroyed. A fast player earns the finale
 * in about four minutes and a slower one gets closer to ten, and both of them
 * get the same shape of run rather than the same length of one.
 *
 * The clock survives in exactly one place, as a cap. A run that stalls has to
 * end somewhere, and milestone 1 asks for runs inside a 5 to 10 minute window.
 *
 * The director still owns difficulty. The stage owns only shape: when arrivals
 * thin for a breath, when they stop, and therefore when the run may end.
 */

export type RunStage = 'calibration' | 'expansion' | 'pressure' | 'lull' | 'finale'

/**
 * Targets destroyed before the closing wave.
 *
 * Kills arrive at roughly the rate the director is feeding the player, which is
 * itself a share of their typing speed, so a fixed target converts directly
 * into "a run lasts until you have done enough", independent of how fast you
 * are. Section 21 question 8 says run length is settled by play, so this is the
 * one number to turn.
 */
export const FINALE_KILLS = 340

/** No run may run longer than this, however badly it is going. */
export const HARD_CAP_MS = 10 * 60 * 1000

interface StageBand {
  stage: RunStage
  /** Fraction of the way to the finale at which this stage begins. */
  from: number
  /** Multiplier on the director's spawn interval. Above 1 is a breath. */
  intervalScale: number
}

const BANDS: readonly StageBand[] = [
  { stage: 'calibration', from: 0, intervalScale: 1 },
  { stage: 'expansion', from: 0.16, intervalScale: 1 },
  { stage: 'pressure', from: 0.42, intervalScale: 1 },
  // A real drop in arrivals rather than a pause, because a game that stops
  // entirely reads as broken rather than as a breath.
  { stage: 'lull', from: 0.88, intervalScale: 2.4 },
  { stage: 'finale', from: 1, intervalScale: 1 },
]

export interface RunProgress {
  kills: number
  elapsedMs: number
}

/** How far through the arc the run is, in [0, 1]. */
export function progressOf(run: RunProgress): number {
  const byKills = run.kills / FINALE_KILLS
  const byClock = run.elapsedMs / HARD_CAP_MS
  return Math.min(1, Math.max(0, Math.max(byKills, byClock)))
}

function bandAt(progress: number): StageBand {
  let found = BANDS[0]!
  for (const band of BANDS) {
    if (progress >= band.from) found = band
  }
  return found
}

export function stageAt(run: RunProgress): RunStage {
  return bandAt(progressOf(run)).stage
}

export function intervalScaleAt(run: RunProgress): number {
  return bandAt(progressOf(run)).intervalScale
}

/** Human-facing name for the stage, shown when it changes. */
export const STAGE_LABEL: Record<RunStage, string> = {
  calibration: 'warming up',
  expansion: 'expanding',
  pressure: 'under pressure',
  lull: 'catch your breath',
  finale: 'final wave',
}

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
  return 5 + Math.round(dial * 5)
}
