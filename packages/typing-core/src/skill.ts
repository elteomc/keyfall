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
 * **Hierarchical shrinkage.** A digram estimate is pulled toward what the model
 * predicts for it, and every layer of that prediction is pulled toward the layer
 * behind it, each in proportion to how little evidence stands behind it. Three
 * observations of `qz` therefore say almost nothing and three hundred say almost
 * everything, with no threshold in between where the estimate suddenly starts
 * being trusted. Section 5 already applies this one level deep. Section 6 asks
 * for more, and this is it.
 *
 * **Two questions of the same data, not one question with finer buckets.** The
 * prediction asks what kind of movement this is *and* which key it lands on,
 * and multiplies the two answers. The distinction matters and the first version
 * of this file got it wrong. Combining the features into one bucket key would
 * give six classes times twenty-six keys, so 156 buckets holding a couple of
 * dozen keystrokes each, which is the sparsity the classes existed to escape.
 * Asking two separate questions divides nothing: every keystroke informs both
 * its class and its landing key.
 *
 * That mistake cost real accuracy. Measured against the first real player
 * profile, movement class alone explained **2.9 percent** of the variation in
 * their transition times and the landing key alone explained **25.6**. The axis
 * that was left out mattered roughly nine times more than the one that was
 * built. Their four slowest pairs, `st`, `nt`, `et` and `ct`, all landed on `t`
 * and sat in three different movement classes, so each class averaged the
 * penalty away and none of them could see it.
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
  /** Hits at which a landing key is trusted as much as no effect at all. */
  landingPrior?: number
  /** Hits a landing key needs before it may be called a slow reach. */
  minLandingHits?: number
  /** Factor at or above which a landing key is a slow reach. */
  landingStrain?: number
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
  landingPrior: 30,
  minLandingHits: 40,
  landingStrain: 1.2,
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
  /**
   * What the model predicts before this pair's own evidence is folded in.
   *
   * This is the number that makes an unseen pair estimable, and the one the
   * landing key term improves.
   */
  expectedMs: number
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

/** A key this player reaches for more slowly than the rest of their typing. */
export interface LandingEstimate {
  key: string
  /** How much slower than predicted, where 1 is exactly as predicted. */
  factor: number
  hits: number
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
 * Bounds on how far one pair may pull its landing key.
 *
 * A landing factor is an average of ratios, and an average of ratios is easily
 * dragged by a single extreme one with a large sample count behind it. Clamping
 * each pair's contribution caps any one of them without needing a median. Real
 * landing effects come from many pairs agreeing, so this never touches them:
 * the strongest one measured on a real profile was 1.42.
 */
const MIN_RESIDUAL = 0.5
const MAX_RESIDUAL = 2.5

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
  private readonly landingFactorByKey = new Map<string, number>()
  private readonly landingHitsByKey = new Map<string, number>()
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

    this.buildLandingFactors()
  }

  /**
   * How much slower each key is to arrive at than its movement alone explains.
   *
   * Measured on what the class prediction leaves over, so the two terms cannot
   * count the same slowness twice. A key with no effect comes out at 1.0 and the
   * model behaves exactly as it did before this term existed, which is what
   * makes it safe to add for players who do not have a slow reach.
   */
  private buildLandingFactors(): void {
    const weighted = new Map<string, number>()

    for (const [key, cell] of this.cells) {
      const [from, to] = key.split(' ')
      if (from === undefined || to === undefined || cell.hits <= 0) continue
      const kind = classifyDigram(from, to)
      if (kind === null) continue

      const predicted = this.classMeanMs(kind)
      if (predicted <= 0) continue

      const residual = Math.min(
        MAX_RESIDUAL,
        Math.max(MIN_RESIDUAL, cell.meanMs / predicted),
      )
      weighted.set(to, (weighted.get(to) ?? 0) + residual * cell.hits)
      this.landingHitsByKey.set(to, (this.landingHitsByKey.get(to) ?? 0) + cell.hits)
    }

    for (const [to, total] of weighted) {
      const hits = this.landingHitsByKey.get(to) ?? 0
      if (hits <= 0) continue
      this.landingFactorByKey.set(
        to,
        shrink(total / hits, 1, hits, this.config.landingPrior),
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

  /** How much slower this player is to arrive at a key. 1 is no effect. */
  landingFactor(key: string): number {
    return this.landingFactorByKey.get(key) ?? 1
  }

  landingHits(key: string): number {
    return this.landingHitsByKey.get(key) ?? 0
  }

  /**
   * What the model predicts for a pair before that pair's own evidence.
   *
   * Two questions of the same data, multiplied: what kind of movement is this,
   * and which key does it land on. This is the number that lets the model price
   * a transition the player has never made.
   */
  expected(from: string, to: string): number | null {
    const kind = classifyDigram(from, to)
    if (kind === null) return null
    return this.classMeanMs(kind) * this.landingFactor(to)
  }

  /**
   * Keys this player reaches for slowly, worst first.
   *
   * A better sentence for a person than the pairs underneath it. Four separate
   * findings of `st`, `nt`, `et` and `ct` are one finding about `t`, and only
   * the second is something a player can do anything with.
   */
  reaches(limit = 3): LandingEstimate[] {
    const out: LandingEstimate[] = []
    for (const [key, factor] of this.landingFactorByKey) {
      const hits = this.landingHits(key)
      if (hits >= this.config.minLandingHits && factor >= this.config.landingStrain) {
        out.push({ key, factor, hits })
      }
    }
    return out.sort((a, b) => b.factor - a.factor).slice(0, limit)
  }

  /** The estimate for one transition, with or without samples behind it. */
  digram(from: string, to: string): DigramEstimate | null {
    const kind = classifyDigram(from, to)
    if (kind === null) return null

    const cell = this.cells.get(`${from} ${to}`)
    const classMs = this.classMeanMs(kind)
    const classErrors = this.classErrorRate(kind)
    const expectedMs = classMs * this.landingFactor(to)

    const hits = cell?.hits ?? 0
    const samples = cell?.samples ?? 0
    const meanMs = shrink(cell?.meanMs ?? expectedMs, expectedMs, hits, this.config.digramPrior)
    const errorRate = shrink(
      samples > 0 ? (cell?.errors ?? 0) / samples : classErrors,
      classErrors,
      samples,
      this.config.digramPrior,
    )

    // Strain is read off the raw observation, not the shrunk estimate. The
    // shrunk one is pulled toward the prediction by construction, so using it
    // here would quietly erase the very residual being looked for.
    //
    // It is also compared against the *class* baseline rather than the full
    // prediction, which looks like an inconsistency and is the point. The class
    // term removes what is hard for everybody, which is not this player's
    // problem to train. The landing term is personal, so folding it in here
    // would explain a slow `t` away and hide the most trainable thing in the
    // profile behind the very machinery built to find it.
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
      expectedMs,
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
