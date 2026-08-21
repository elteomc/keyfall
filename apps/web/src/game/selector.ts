import {
  type Bucket,
  type Candidate,
  type Profile,
  SkillModel,
  buildPool,
  selectCandidate,
} from '@keyfall/typing-core'

import { CORPUS, type Band } from './corpus'
import type { Rng } from './rng'

/**
 * The adaptive word selector.
 *
 * `typing-core` decides what each word is worth to this player and which bucket
 * it belongs in. This decides which bucket the run should be asking for, which
 * is a question about the arena rather than about typing, and it holds the
 * brakes that stop the answer from turning into a drill.
 *
 * The policy in one sentence: **teach when the player has room, and get out of
 * the way when they do not.**
 *
 * Product principle 7 asks that a player feel adaptation without feeling
 * punished by it, and the surest way to break that is to serve someone their
 * worst digram at the exact moment four enemies are converging. They will fail
 * it, and the game will have chosen the moment. So weakness is trained when the
 * arena is calm and quietly withdrawn as pressure rises, where the same
 * material would read as the game piling on.
 *
 * Nothing here reacts to how *well* the player is doing, which is the same line
 * the director holds (D10, D16). Pressure is how much the arena is currently
 * asking of them. A player who is coasting gets harder material because they
 * have room for it, not because they earned a punishment.
 */

export type PressureBand = 'low' | 'medium' | 'high'

/**
 * How the run divides its spawns, by how hard the player is being pushed.
 *
 * Weakness falls to almost nothing at high pressure and comfort takes over.
 * Frontier is the one that stays broadly present, because a word slightly
 * beyond comfortable is the right default at any pressure.
 */
const MIX: Record<PressureBand, Record<Bucket, number>> = {
  low: { weakness: 0.35, frontier: 0.35, exploration: 0.2, comfort: 0.1 },
  medium: { weakness: 0.2, frontier: 0.4, exploration: 0.15, comfort: 0.25 },
  high: { weakness: 0.05, frontier: 0.25, exploration: 0.1, comfort: 0.6 },
}

const LOW_MEDIUM = 0.35
const MEDIUM_HIGH = 0.62

/**
 * How far past a threshold pressure must go before the mix follows it.
 *
 * This is the same hysteresis the director applies to intensity, for the same
 * reason. A reading that sits on a boundary would otherwise flip the mix on
 * every spawn, and a player would meet their weakness and then not and then
 * again with nothing in the run to explain it.
 */
const BAND_MARGIN = 0.07

/** Spawns the anti-drill cap looks back over. */
const CAP_WINDOW = 10

/**
 * Weakness spawns allowed inside that window.
 *
 * The milestone asks for visibly different challenge distributions *without
 * obvious repetitive drilling*, and those pull against each other: the crudest
 * way to make two players' runs differ is to serve each of them their worst
 * digram forever. This is the ceiling that forbids it, and it binds regardless
 * of what the mix asks for.
 */
const MAX_WEAKNESS_IN_WINDOW = 3

const RECENT_WORDS = 12
const RECENT_DIGRAMS = 8

export interface SelectorReport {
  /** Whether the profile held enough evidence to steer on at all. */
  adapting: boolean
  counts: Record<Bucket, number>
  /** Weakness digrams actually served, most served first. */
  trained: { digram: string; count: number }[]
}

function emptyCounts(): Record<Bucket, number> {
  return { comfort: 0, frontier: 0, weakness: 0, exploration: 0 }
}

export class WordSelector {
  private readonly pools: Record<Band, Candidate[]>
  private readonly model: SkillModel

  private band: PressureBand = 'low'
  private recentWords: string[] = []
  private recentDigrams: string[] = []
  private recentBuckets: Bucket[] = []
  private counts = emptyCounts()
  private trained = new Map<string, number>()

  constructor(profile: Profile) {
    this.model = SkillModel.from(profile.transitions)
    this.pools = {
      short: buildPool(CORPUS.short, this.model, profile.corpusExposure),
      medium: buildPool(CORPUS.medium, this.model, profile.corpusExposure),
      long: buildPool(CORPUS.long, this.model, profile.corpusExposure),
    }
  }

  /**
   * Draws the next word.
   *
   * `exclude` is what the arena already holds, because two identical words on
   * screen make the prefix lock ambiguous in a way the player cannot resolve.
   */
  next(band: Band, pressure: number, exclude: ReadonlySet<string>, rng: Rng): string {
    this.settleBand(pressure)

    const requested = this.capped(this.rollBucket(rng))
    const selection = selectCandidate(
      this.pools[band],
      requested,
      { recentWords: this.recentWords, recentDigrams: this.recentDigrams, excluded: exclude },
      () => rng.next(),
    )

    if (selection === null) return this.anyWord(band, exclude, rng)

    this.remember(selection.candidate, selection.bucket)
    return selection.candidate.word
  }

  /** What the run trained, for the result screen. */
  report(): SelectorReport {
    return {
      adapting: this.model.confident(),
      counts: { ...this.counts },
      trained: [...this.trained.entries()]
        .map(([digram, count]) => ({ digram, count }))
        .sort((a, b) => b.count - a.count),
    }
  }

  /** The current pressure band, for tests and telemetry. */
  currentBand(): PressureBand {
    return this.band
  }

  /** The bucket the last word actually came from, after caps and fallbacks. */
  lastBucket(): Bucket | null {
    return this.recentBuckets[0] ?? null
  }

  /** The model behind the pools, so callers can name a weakness by hand. */
  skill(): SkillModel {
    return this.model
  }

  private settleBand(pressure: number): void {
    if (this.band === 'low' && pressure > LOW_MEDIUM + BAND_MARGIN) this.band = 'medium'
    else if (this.band === 'medium' && pressure < LOW_MEDIUM - BAND_MARGIN) this.band = 'low'
    else if (this.band === 'medium' && pressure > MEDIUM_HIGH + BAND_MARGIN) this.band = 'high'
    else if (this.band === 'high' && pressure < MEDIUM_HIGH - BAND_MARGIN) this.band = 'medium'
  }

  private rollBucket(rng: Rng): Bucket {
    const mix = MIX[this.band]
    let roll = rng.next()
    for (const bucket of ['weakness', 'frontier', 'exploration', 'comfort'] as const) {
      roll -= mix[bucket]
      if (roll <= 0) return bucket
    }
    return 'frontier'
  }

  /** The anti-drill ceiling, applied after the mix and before the draw. */
  private capped(bucket: Bucket): Bucket {
    if (bucket !== 'weakness') return bucket
    const served = this.recentBuckets.filter((b) => b === 'weakness').length
    return served >= MAX_WEAKNESS_IN_WINDOW ? 'frontier' : bucket
  }

  private remember(candidate: Candidate, bucket: Bucket): void {
    this.counts[bucket] += 1

    this.recentWords = [candidate.word, ...this.recentWords].slice(0, RECENT_WORDS)
    this.recentBuckets = [bucket, ...this.recentBuckets].slice(0, CAP_WINDOW)

    if (bucket !== 'weakness') return
    for (const digram of candidate.cost.weaknesses) {
      this.trained.set(digram, (this.trained.get(digram) ?? 0) + 1)
    }
    this.recentDigrams = [...candidate.cost.weaknesses, ...this.recentDigrams].slice(
      0,
      RECENT_DIGRAMS,
    )
  }

  /**
   * Last resort when every candidate in the band is already on screen.
   *
   * Only reachable if the arena holds most of a band at once, which the spawn
   * rate makes unlikely rather than impossible. Serving a duplicate is worse
   * than serving an unadapted word, so this ignores the buckets and not the
   * exclusion.
   */
  private anyWord(band: Band, exclude: ReadonlySet<string>, rng: Rng): string {
    const free = CORPUS[band].filter((word) => !exclude.has(word))
    const pool = free.length > 0 ? free : CORPUS[band]
    return rng.pick(pool)
  }
}
