/**
 * The local player profile.
 *
 * Section 14 of the technical plan asks for aggregate skill statistics, recent
 * runs, corpus exposure, personal bests and settings, and is explicit that the
 * browser must not accumulate raw events forever. So this file holds the shape
 * that lives forever, and every function in it is pure. Where it is stored, and
 * the raw event history that is pruned beside it, are the game layer's problem.
 *
 * Keeping the fold pure is what makes it testable without a browser, and it
 * means a corrupt or half-written record can never be produced by the merge
 * itself.
 */

import type { TransitionStat } from './transitions'

/** Bumped whenever the shape changes in a way an old record cannot satisfy. */
export const PROFILE_VERSION = 1

/** Runs kept in full. Older ones survive only inside the aggregates. */
export const MAX_RECENT_RUNS = 20

/**
 * Distinct words tracked for exposure.
 *
 * The v1 corpus is far smaller than this, so the cap only matters if the corpus
 * grows or a future mode generates words. It exists so a long-lived profile has
 * a bounded size rather than a merely slow-growing one.
 */
export const MAX_TRACKED_WORDS = 2000

/** Weight of the newest run in the long-term skill estimates. */
const RUN_ETA = 0.2

export interface RunRecord {
  runId: string
  startedAtMs: number
  durationMs: number
  /**
   * How the run ended. Deliberately a plain string: the profile has no opinion
   * about the game's vocabulary, which is what keeps this layer reusable.
   */
  outcome: string
  score: number
  kills: number
  wpm: number
  accuracy: number
  peakBurstWpm: number
  rhythm: number | null
  acquisitionMs: number | null
}

export interface AggregateStats {
  runs: number
  totalTimeMs: number
  totalKeys: number
  correctKeys: number
  /** Exponentially weighted, so it tracks the player rather than their history. */
  typicalWpm: number
  typicalAccuracy: number
}

export interface PersonalBests {
  score: number
  wpm: number
  accuracy: number
  kills: number
  longestRunMs: number
}

export interface StoredTransition {
  meanMs: number
  samples: number
  errors: number
}

export interface Profile {
  version: number
  createdAtMs: number
  updatedAtMs: number
  aggregate: AggregateStats
  bests: PersonalBests
  /** Newest first. */
  recentRuns: RunRecord[]
  /** Word to the number of times it has been targeted. */
  corpusExposure: Record<string, number>
  /** Digram key `"a b"` to its long-term estimate. */
  transitions: Record<string, StoredTransition>
}

export function emptyProfile(nowMs: number): Profile {
  return {
    version: PROFILE_VERSION,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    aggregate: {
      runs: 0,
      totalTimeMs: 0,
      totalKeys: 0,
      correctKeys: 0,
      typicalWpm: 0,
      typicalAccuracy: 0,
    },
    bests: { score: 0, wpm: 0, accuracy: 0, kills: 0, longestRunMs: 0 },
    recentRuns: [],
    corpusExposure: {},
    transitions: {},
  }
}

export interface RunContribution {
  record: RunRecord
  /** Keys pressed during the run, for the lifetime accuracy total. */
  totalKeys: number
  correctKeys: number
  /** Words targeted during the run, for corpus exposure. */
  words: readonly string[]
  /** This run's digram table, folded into the long-term one. */
  transitions: readonly TransitionStat[]
}

/**
 * Folds one finished run into the profile and returns a new profile.
 *
 * Nothing is mutated, so a caller that fails to persist the result has not
 * corrupted the profile it was holding.
 */
export function recordRun(profile: Profile, run: RunContribution, nowMs: number): Profile {
  const { record } = run
  const previous = profile.aggregate

  // The first run has no history to be weighed against, so it sets the estimate
  // outright instead of being dragged toward a zero that means "unknown".
  const first = previous.runs === 0
  const eta = first ? 1 : RUN_ETA

  return {
    ...profile,
    version: PROFILE_VERSION,
    updatedAtMs: nowMs,
    aggregate: {
      runs: previous.runs + 1,
      totalTimeMs: previous.totalTimeMs + record.durationMs,
      totalKeys: previous.totalKeys + run.totalKeys,
      correctKeys: previous.correctKeys + run.correctKeys,
      typicalWpm: previous.typicalWpm + eta * (record.wpm - previous.typicalWpm),
      typicalAccuracy: previous.typicalAccuracy + eta * (record.accuracy - previous.typicalAccuracy),
    },
    bests: {
      score: Math.max(profile.bests.score, record.score),
      wpm: Math.max(profile.bests.wpm, record.wpm),
      accuracy: Math.max(profile.bests.accuracy, record.accuracy),
      kills: Math.max(profile.bests.kills, record.kills),
      longestRunMs: Math.max(profile.bests.longestRunMs, record.durationMs),
    },
    recentRuns: [record, ...profile.recentRuns].slice(0, MAX_RECENT_RUNS),
    corpusExposure: mergeExposure(profile.corpusExposure, run.words),
    transitions: mergeTransitions(profile.transitions, run.transitions),
  }
}

/** Whether a run beat the profile as it stood *before* that run was folded in. */
export function beatenBests(before: PersonalBests, record: RunRecord): (keyof PersonalBests)[] {
  const beaten: (keyof PersonalBests)[] = []
  if (record.score > before.score) beaten.push('score')
  if (record.wpm > before.wpm) beaten.push('wpm')
  if (record.accuracy > before.accuracy) beaten.push('accuracy')
  if (record.kills > before.kills) beaten.push('kills')
  if (record.durationMs > before.longestRunMs) beaten.push('longestRunMs')
  return beaten
}

function mergeExposure(
  existing: Record<string, number>,
  words: readonly string[],
): Record<string, number> {
  const merged = { ...existing }
  for (const word of words) merged[word] = (merged[word] ?? 0) + 1

  const keys = Object.keys(merged)
  if (keys.length <= MAX_TRACKED_WORDS) return merged

  // Drop the least seen first. Exposure exists to tell familiar material from
  // novel material, and a word seen once carries the least of that signal.
  const kept = keys
    .sort((a, b) => (merged[b] ?? 0) - (merged[a] ?? 0))
    .slice(0, MAX_TRACKED_WORDS)

  const pruned: Record<string, number> = {}
  for (const key of kept) pruned[key] = merged[key] ?? 0
  return pruned
}

/**
 * Folds a run's digram table into the long-term one.
 *
 * Sample counts add and the means combine weighted by them, so a run with three
 * observations of a digram cannot move a lifetime estimate built from three
 * hundred.
 */
function mergeTransitions(
  existing: Record<string, StoredTransition>,
  stats: readonly TransitionStat[],
): Record<string, StoredTransition> {
  const merged = { ...existing }

  for (const stat of stats) {
    const key = `${stat.from} ${stat.to}`
    const prior = merged[key]
    const hits = stat.samples - stat.errors

    if (prior === undefined) {
      merged[key] = { meanMs: stat.meanMs, samples: stat.samples, errors: stat.errors }
      continue
    }

    const priorHits = prior.samples - prior.errors
    const totalHits = priorHits + hits
    merged[key] = {
      meanMs:
        totalHits > 0 ? (prior.meanMs * priorHits + stat.meanMs * hits) / totalHits : prior.meanMs,
      samples: prior.samples + stat.samples,
      errors: prior.errors + stat.errors,
    }
  }

  return merged
}

/** Lifetime accuracy across every run, not the weighted recent estimate. */
export function lifetimeAccuracy(profile: Profile): number {
  const { totalKeys, correctKeys } = profile.aggregate
  return totalKeys === 0 ? 1 : correctKeys / totalKeys
}

export function exportProfile(profile: Profile): string {
  return JSON.stringify(profile, null, 2)
}

/**
 * Parses an exported profile.
 *
 * Returns null rather than throwing, and rather than repairing. A profile that
 * does not check out is replaced by a fresh one, because silently accepting a
 * half-valid record means every later statistic is quietly wrong.
 */
export function importProfile(json: string): Profile | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  return isProfile(parsed) ? parsed : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasNumbers(value: unknown, keys: readonly string[]): boolean {
  if (!isRecord(value)) return false
  return keys.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))
}

export function isProfile(value: unknown): value is Profile {
  if (!isRecord(value)) return false
  if (value['version'] !== PROFILE_VERSION) return false
  if (!Array.isArray(value['recentRuns'])) return false
  if (!isRecord(value['corpusExposure']) || !isRecord(value['transitions'])) return false

  const aggregateKeys = ['runs', 'totalTimeMs', 'totalKeys', 'correctKeys', 'typicalWpm', 'typicalAccuracy']
  const bestKeys = ['score', 'wpm', 'accuracy', 'kills', 'longestRunMs']

  return (
    hasNumbers(value['aggregate'], aggregateKeys) &&
    hasNumbers(value['bests'], bestKeys) &&
    typeof value['createdAtMs'] === 'number'
  )
}
