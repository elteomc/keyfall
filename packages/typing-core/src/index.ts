export type { TypingEvent, EventRecorder } from './events'
export { createRecorder } from './events'

export type {
  TargetCandidate,
  UnlockedResolution,
  LockedResolution,
  ErrorPolicy,
} from './targeting'
export {
  resolveUnlockedKey,
  resolveLockedKey,
  distinguishingPrefix,
  errorSeverity,
} from './targeting'

export type { RhythmOptions } from './metrics'
export {
  mean,
  stdDev,
  interKeyIntervals,
  coefficientOfVariation,
  rhythmScore,
  wordsPerMinute,
  accuracy,
} from './metrics'

export type { ComboComponents, ComboOptions, ComboTier, WordOutcome } from './combo'
export { ComboTracker, comboGain } from './combo'

export type { TransitionStat, TransitionTableOptions } from './transitions'
export { TransitionTable } from './transitions'

export type {
  Confidence,
  Direction,
  Observation,
  ObservationInput,
  ObservationKind,
  ObservationOptions,
} from './observations'
export { deriveObservations } from './observations'

export type {
  AggregateStats,
  PersonalBests,
  Profile,
  RunContribution,
  RunRecord,
  StoredTransition,
} from './profile'
export {
  MAX_RECENT_RUNS,
  MAX_TRACKED_WORDS,
  PROFILE_VERSION,
  beatenBests,
  emptyProfile,
  exportProfile,
  importProfile,
  isProfile,
  lifetimeAccuracy,
  recordRun,
} from './profile'
