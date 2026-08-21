/**
 * The player's motor profile, as a model that can price unseen material.
 *
 * The transition table records what a player has already typed. This turns
 * that record into predictions about what they have not, which is what an
 * adaptive selector needs: given two words neither of which the player has met,
 * which one is harder *for them*.
 *
 * Two ideas carry the whole file.
 *
 * **Hierarchical shrinkage.** A digram estimate is pulled toward the average
 * for its movement class, and a class average is pulled toward the player's
 * global average, each in proportion to how little evidence stands behind it.
 * Three observations of `qz` therefore say almost nothing and three hundred say
 * almost everything, with no threshold in between where the estimate suddenly
 * starts being trusted. Section 5 already applies this one level deep. Section
 * 6 asks for the second level, and this is it.
 *
 * **Weakness is relative to the player, not to the keyboard.** A slow typist is
 * slow everywhere, so ranking their digrams by raw milliseconds just recovers
 * the universal ordering: same-finger pairs are hard for everybody. A personal
 * weakness is a transition where a player is worse than their *own* profile
 * predicts, which is why the comparison is against their class average rather
 * than against a global constant. This is the property the milestone 3 exit
 * criterion depends on. Two typists of similar speed have similar class
 * averages and quite different residuals, and the residual is the signal.
 */

import { type DigramClass, classifyDigram } from './keyboard'
import type { StoredTransition } from './profile'

export interface SkillModelOptions {
  /** Hits at which a digram is trusted as much as its class average. */
  digramPrior?: number
  /** Hits at which a class is trusted as much as the global average. */
  classPrior?: number
  /** Milliseconds an expected wrong key adds to a word's cost. */
  errorPenaltyMs?: number
  /** Hits a digram needs before it may be called a weakness. */
  minWeaknessHits?: number
  /** Strain at or above which a digram is a weakness. */
  weaknessStrain?: number
  /**
   * Extra error rate that counts as much as doubling the time.
   *
   * Both halves of "worse than predicted" have to end up on one axis, and this
   * is the exchange rate between them.
   */
  errorEquivalent?: number
  /** Total hits below which the model refuses to claim it knows the player. */
  minTotalHits?: number
}

type Config = Required<SkillModelOptions>

const DEFAULTS: Config = {
  digramPrior: 8,
  classPrior: 40,
  errorPenaltyMs: 400,
  minWeaknessHits: 12,
  weaknessStrain: 1.25,
  errorEquivalent: 0.25,
  minTotalHits: 400,
}

export interface DigramEstimate {
  from: string
  to: string
  kind: DigramClass
  /** Hierarchical estimate in milliseconds, usable even with no samples. */
  meanMs: number
  /** Hierarchical error rate in [0, 1]. */
  errorRate: number
  /** Correct keystrokes observed for this pair. */
  hits: number
  /**
   * How much worse than this player's own class average, on one axis.
   *
   * 1.0 is exactly as predicted. Above 1.0 is a residual worth training.
   */
  strain: number
  /** Whether the residual is both large enough and well enough evidenced. */
  weakness: boolean
}

export interface WordCost {
  word: string
  /** Predicted milliseconds, including the price of expected mistakes. */
  totalMs: number
  /** `totalMs` over the number of transitions, so length is not difficulty. */
  perTransitionMs: number
  /** Expected wrong keys across the word. */
  errorRisk: number
  /** How little the model knows about this word's transitions, in [0, 1]. */
  novelty: number
  /** Digram keys in this word the model calls weaknesses. */
  weaknesses: string[]
}

interface Cell {
  meanMs: number
  hits: number
  errors: number
  samples: number
}

function shrink(observed: number, prior: number, evidence: number, k: number): number {
  if (evidence <= 0) return prior
  const w = evidence / (evidence + k)
  return w * observed + (1 - w) * prior
}

/**
 * A read-only view of one player's motor profile.
 *
 * Built once from a stored profile and then queried, rather than updated as a
 * run proceeds. Holding it still for the length of a run is what keeps the
 * material a player meets legible: the alternative is a model that shifts
 * under them mid-run, where a word served at minute five cannot be explained
 * by anything the player could have seen.
 */
export class SkillModel {
  private readonly config: Config
  private readonly cells = new Map<string, Cell>()
  private readonly classMeanMsByKind = new Map<DigramClass, number>()
  private readonly classErrorRateByKind = new Map<DigramClass, number>()
  private readonly globalMeanMsValue: number
  private readonly globalErrorRateValue: number
  private readonly totalHitsValue: number

  private constructor(transitions: Record<string, StoredTransition>, options: SkillModelOptions) {
    this.config = { ...DEFAULTS, ...options }

    let globalMs = 0
    let globalHits = 0
    let globalErrors = 0
    let globalSamples = 0

    const classMs = new Map<DigramClass, number>()
    const classHits = new Map<DigramClass, number>()
    const classErrors = new Map<DigramClass, number>()
    const classSamples = new Map<DigramClass, number>()

    for (const [key, stored] of Object.entries(transitions)) {
      const [from, to] = key.split(' ')
      if (from === undefined || to === undefined) continue
      const kind = classifyDigram(from, to)
      if (kind === null) continue

      const hits = Math.max(0, stored.samples - stored.errors)
      this.cells.set(key, {
        meanMs: stored.meanMs,
        hits,
        errors: stored.errors,
        samples: stored.samples,
      })

      globalMs += stored.meanMs * hits
      globalHits += hits
      globalErrors += stored.errors
      globalSamples += stored.samples

      classMs.set(kind, (classMs.get(kind) ?? 0) + stored.meanMs * hits)
      classHits.set(kind, (classHits.get(kind) ?? 0) + hits)
      classErrors.set(kind, (classErrors.get(kind) ?? 0) + stored.errors)
      classSamples.set(kind, (classSamples.get(kind) ?? 0) + stored.samples)
    }

    this.totalHitsValue = globalHits
    this.globalMeanMsValue = globalHits > 0 ? globalMs / globalHits : 0
    this.globalErrorRateValue = globalSamples > 0 ? globalErrors / globalSamples : 0

    for (const kind of classMs.keys()) {
      const hits = classHits.get(kind) ?? 0
      const samples = classSamples.get(kind) ?? 0
      const observedMs = hits > 0 ? (classMs.get(kind) ?? 0) / hits : this.globalMeanMsValue
      const observedErrors = samples > 0 ? (classErrors.get(kind) ?? 0) / samples : 0

      this.classMeanMsByKind.set(
        kind,
        shrink(observedMs, this.globalMeanMsValue, hits, this.config.classPrior),
      )
      this.classErrorRateByKind.set(
        kind,
        shrink(observedErrors, this.globalErrorRateValue, samples, this.config.classPrior),
      )
    }
  }

  static from(
    transitions: Record<string, StoredTransition>,
    options: SkillModelOptions = {},
  ): SkillModel {
    return new SkillModel(transitions, options)
  }

  /**
   * Whether there is enough evidence to steer on.
   *
   * A caller that ignores this gets a model whose every estimate is the same
   * number, which ranks candidates by nothing at all. Saying so plainly is
   * better than returning confident-looking noise.
   */
  confident(): boolean {
    return this.totalHitsValue >= this.config.minTotalHits
  }

  totalHits(): number {
    return this.totalHitsValue
  }

  globalMeanMs(): number {
    return this.globalMeanMsValue
  }

  classMeanMs(kind: DigramClass): number {
    return this.classMeanMsByKind.get(kind) ?? this.globalMeanMsValue
  }

  classErrorRate(kind: DigramClass): number {
    return this.classErrorRateByKind.get(kind) ?? this.globalErrorRateValue
  }

  /** The estimate for one transition, with or without samples behind it. */
  digram(from: string, to: string): DigramEstimate | null {
    const kind = classifyDigram(from, to)
    if (kind === null) return null

    const cell = this.cells.get(`${from} ${to}`)
    const classMs = this.classMeanMs(kind)
    const classErrors = this.classErrorRate(kind)

    const hits = cell?.hits ?? 0
    const samples = cell?.samples ?? 0
    const meanMs = shrink(cell?.meanMs ?? classMs, classMs, hits, this.config.digramPrior)
    const errorRate = shrink(
      samples > 0 ? (cell?.errors ?? 0) / samples : classErrors,
      classErrors,
      samples,
      this.config.digramPrior,
    )

    // Strain is read off the raw observation, not the shrunk estimate. The
    // shrunk one is pulled toward the class average by construction, so using
    // it here would quietly erase the very residual being looked for.
    const observedMs = cell?.meanMs ?? classMs
    const observedErrorRate = samples > 0 ? (cell?.errors ?? 0) / samples : classErrors
    const timeRatio = classMs > 0 ? observedMs / classMs : 1
    const errorExcess = Math.max(0, observedErrorRate - classErrors)
    const strain = timeRatio + errorExcess / this.config.errorEquivalent

    return {
      from,
      to,
      kind,
      meanMs,
      errorRate,
      hits,
      strain,
      weakness: hits >= this.config.minWeaknessHits && strain >= this.config.weaknessStrain,
    }
  }

  /** What a word is predicted to cost this player. */
  cost(word: string): WordCost {
    let totalMs = 0
    let errorRisk = 0
    let novelty = 0
    let transitions = 0
    const weaknesses: string[] = []

    for (let i = 1; i < word.length; i++) {
      const from = word[i - 1] as string
      const to = word[i] as string
      const estimate = this.digram(from, to)
      if (estimate === null) continue

      transitions += 1
      totalMs += estimate.meanMs
      errorRisk += estimate.errorRate
      novelty += 1 / (1 + estimate.hits)
      if (estimate.weakness) weaknesses.push(`${from} ${to}`)
    }

    totalMs += this.config.errorPenaltyMs * errorRisk

    return {
      word,
      totalMs,
      perTransitionMs: transitions > 0 ? totalMs / transitions : 0,
      errorRisk,
      novelty: transitions > 0 ? novelty / transitions : 1,
      weaknesses,
    }
  }

  /** The player's own worst residuals, most strained first. */
  weaknesses(limit = 8): DigramEstimate[] {
    const out: DigramEstimate[] = []
    for (const key of this.cells.keys()) {
      const [from, to] = key.split(' ')
      if (from === undefined || to === undefined) continue
      const estimate = this.digram(from, to)
      if (estimate?.weakness) out.push(estimate)
    }
    return out.sort((a, b) => b.strain - a.strain).slice(0, limit)
  }
}
