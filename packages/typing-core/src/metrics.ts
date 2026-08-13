/**
 * Timing measurements derived from the event stream.
 *
 * Two latencies are kept apart on purpose. Acquisition latency is the time
 * from a target becoming actionable to the first correct key. Motor latency is
 * the timing between correct keys once typing has started. They are different
 * skills and mixing them makes both estimates useless.
 */

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0
  let total = 0
  for (const x of xs) total += x
  return total / xs.length
}

export function stdDev(xs: readonly number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  let acc = 0
  for (const x of xs) acc += (x - m) * (x - m)
  return Math.sqrt(acc / (xs.length - 1))
}

/** Intervals between consecutive timestamps, in milliseconds. */
export function interKeyIntervals(timestampsMs: readonly number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < timestampsMs.length; i++) out.push(timestampsMs[i]! - timestampsMs[i - 1]!)
  return out
}

/**
 * Coefficient of variation. Raw variance is scale dependent, so a fast typist
 * would always look smoother than a slow one. Dividing by the mean fixes that.
 */
export function coefficientOfVariation(xs: readonly number[]): number | null {
  if (xs.length < 2) return null
  const m = mean(xs)
  if (m <= 0) return null
  return stdDev(xs) / m
}

export interface RhythmOptions {
  /** Decay constant of the bounded score. Higher means harsher. */
  alpha?: number
  /** Minimum intervals required before a score is meaningful. */
  minIntervals?: number
  /** Intervals above this are treated as interruptions and dropped. */
  pauseCutoffMs?: number
}

/**
 * Bounded rhythm score in (0, 1], computed as exp(-alpha * CV).
 *
 * This is a prototype metric, not gospel. Feed it within-word intervals only:
 * reaction time before the first key and pauses between words are separate
 * measurements and must not be charged to rhythm.
 */
export function rhythmScore(intervalsMs: readonly number[], options: RhythmOptions = {}): number | null {
  const { alpha = 1.2, minIntervals = 3, pauseCutoffMs = 1200 } = options
  const kept = intervalsMs.filter((dt) => dt > 0 && dt < pauseCutoffMs)
  if (kept.length < minIntervals) return null

  const cv = coefficientOfVariation(kept)
  if (cv === null) return null
  return Math.exp(-alpha * cv)
}

/** Standard typing-test convention: one word is five characters. */
export function wordsPerMinute(chars: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return 0
  return chars / 5 / (elapsedMs / 60000)
}

export function accuracy(correct: number, total: number): number {
  if (total <= 0) return 1
  return correct / total
}
