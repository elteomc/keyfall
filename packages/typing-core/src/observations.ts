/**
 * What the run has to say about how the player typed.
 *
 * Section 12 of the product spec asks for at most two or three observations,
 * and warns in the same breath against pretending to statistical certainty too
 * early. So nothing here returns a sentence. Each observation carries what was
 * found, which way it went, and how much the sample supports it. The caller
 * chooses the words, which keeps "seems slower" and "was slower" as one
 * decision in one place instead of a judgement scattered through the copy.
 *
 * Every measurement is taken inside a single run. Local persistence arrives
 * with milestone 2, so nothing here may claim a trend across sessions. That
 * rules out the spec's own "appears to be improving" until there is a previous
 * run to improve on.
 */

import type { TypingEvent } from './events'
import type { TransitionStat } from './transitions'
import { mean } from './metrics'

export type ObservationKind = 'slowest-transition' | 'accuracy-under-pressure' | 'rhythm-drift'

/** How far the sample supports the claim. */
export type Confidence = 'tentative' | 'settled'

export type Direction = 'better' | 'worse' | 'steady'

export interface Observation {
  kind: ObservationKind
  direction: Direction
  confidence: Confidence
  /** Numbers the caller may quote. What they mean depends on `kind`. */
  values: number[]
  /** Digrams involved, when the observation is about a transition. */
  digrams: string[]
}

export interface ObservationInput {
  events: readonly TypingEvent[]
  /** Already sample-gated and shrunk, slowest first. */
  slowest: readonly TransitionStat[]
  /** One rhythm score per completed word, in the order they were completed. */
  rhythmSamples: readonly number[]
}

export interface ObservationOptions {
  maxObservations?: number
  /** Pressure at or above which the arena counts as crowded. */
  pressedAt?: number
  /** Keystrokes needed in each bucket before pressure is worth comparing. */
  minBucketKeys?: number
  /** Words needed in each half before a rhythm drift is worth reporting. */
  minHalfWords?: number
  /** Sample count at which a claim stops being tentative. */
  settledFactor?: number
}

type Config = Required<ObservationOptions>

const DEFAULTS: Config = {
  maxObservations: 3,
  pressedAt: 0.5,
  minBucketKeys: 25,
  minHalfWords: 4,
  settledFactor: 3,
}

/** A second slow transition is worth naming only if it is nearly as slow. */
const COMPANION_RATIO = 0.85

/** Accuracy gaps smaller than this are noise, not a finding. */
const ACCURACY_STEADY = 0.02
const ACCURACY_WORSE = 0.05

/** Rhythm is already a bounded score, so the same band works in both directions. */
const RHYTHM_BAND = 0.03

export function deriveObservations(
  input: ObservationInput,
  options: ObservationOptions = {},
): Observation[] {
  const config = { ...DEFAULTS, ...options }

  const found = [
    slowestTransition(input.slowest, config),
    accuracyUnderPressure(input.events, config),
    rhythmDrift(input.rhythmSamples, config),
  ].filter((o): o is Observation => o !== null)

  return found.slice(0, config.maxObservations)
}

function slowestTransition(
  slowest: readonly TransitionStat[],
  config: Config,
): Observation | null {
  const worst = slowest[0]
  if (worst === undefined) return null

  const digrams = [`${worst.from}${worst.to}`]
  const values = [worst.shrunkMeanMs]
  let samples = worst.samples

  // Naming a single digram invites the player to read it as *the* weakness. If
  // a second one is nearly as slow, saying both is more honest about how flat
  // the top of the list usually is.
  const companion = slowest[1]
  if (companion !== undefined && companion.shrunkMeanMs >= worst.shrunkMeanMs * COMPANION_RATIO) {
    digrams.push(`${companion.from}${companion.to}`)
    values.push(companion.shrunkMeanMs)
    samples = Math.min(samples, companion.samples)
  }

  return {
    kind: 'slowest-transition',
    direction: 'worse',
    confidence: settled(samples, config.minHalfWords * config.settledFactor),
    values,
    digrams,
  }
}

function accuracyUnderPressure(
  events: readonly TypingEvent[],
  config: Config,
): Observation | null {
  let calmCorrect = 0
  let calmTotal = 0
  let pressedCorrect = 0
  let pressedTotal = 0

  for (const event of events) {
    // A reflex space is recorded but is not a game action, so it must not drag
    // an accuracy number down. See D2.
    if (event.key === ' ') continue

    if (event.pressure >= config.pressedAt) {
      pressedTotal += 1
      if (event.correct) pressedCorrect += 1
    } else {
      calmTotal += 1
      if (event.correct) calmCorrect += 1
    }
  }

  if (calmTotal < config.minBucketKeys || pressedTotal < config.minBucketKeys) return null

  const calm = calmCorrect / calmTotal
  const pressed = pressedCorrect / pressedTotal
  const delta = pressed - calm

  return {
    kind: 'accuracy-under-pressure',
    direction: delta >= -ACCURACY_STEADY ? 'better' : delta <= -ACCURACY_WORSE ? 'worse' : 'steady',
    confidence: settled(
      Math.min(calmTotal, pressedTotal),
      config.minBucketKeys * config.settledFactor,
    ),
    values: [calm, pressed],
    digrams: [],
  }
}

function rhythmDrift(samples: readonly number[], config: Config): Observation | null {
  const half = Math.floor(samples.length / 2)
  if (half < config.minHalfWords) return null

  // An odd middle word belongs to neither half, so the two are the same size
  // and a single word cannot tilt the comparison.
  const early = mean(samples.slice(0, half))
  const late = mean(samples.slice(samples.length - half))
  const delta = late - early

  return {
    kind: 'rhythm-drift',
    direction: delta >= RHYTHM_BAND ? 'better' : delta <= -RHYTHM_BAND ? 'worse' : 'steady',
    confidence: settled(half, config.minHalfWords * config.settledFactor),
    values: [early, late],
    digrams: [],
  }
}

function settled(samples: number, threshold: number): Confidence {
  return samples >= threshold ? 'settled' : 'tentative'
}
