export type { TypingEvent, EventRecorder } from './events'
export { createRecorder } from './events'

export type { TargetCandidate, UnlockedResolution, LockedResolution } from './targeting'
export { resolveUnlockedKey, resolveLockedKey, distinguishingPrefix } from './targeting'

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
