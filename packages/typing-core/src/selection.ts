/**
 * Candidate scoring and bucketed selection.
 *
 * Section 11 of the technical plan specifies a rule-based contextual sampler
 * rather than anything learned, on the grounds that it is easier to debug. It
 * asks for the same six steps every time an enemy is needed: generate
 * candidates, price them for this player, sort them into comfort, frontier,
 * weakness and exploration, choose a bucket from game state, and sample inside
 * it with diversity penalties.
 *
 * Steps one to three and five live here. Choosing the bucket needs to know what
 * the arena is doing, so it lives in the game layer beside the director.
 *
 * Three things are worth knowing before reading the rest.
 *
 * **Buckets are relative, so they are never empty.** Comfort and frontier are
 * quantiles of this pool for this player, not fixed millisecond thresholds. A
 * fast player's frontier is a fast player's frontier. It also means the sampler
 * always has something to offer, which matters more than it sounds: a bucket
 * that empties out silently turns into a fallback nobody chose.
 *
 * **Quantiles are taken within one length band.** Every long word costs more
 * than every short word, so pooling them would sort the corpus by length and
 * call it difficulty. The band is already the game's length lever, and this is
 * the lever for everything else.
 *
 * **Nothing here is an argmax.** The best-fitting candidate is the most likely
 * one, not the certain one. Section 11 lists "same word repeatedly" and "same
 * weakness endlessly" as things to avoid, and a deterministic selector produces
 * exactly those the moment a player's profile stops moving.
 */

import type { SkillModel, WordCost } from './skill'

export type Bucket = 'comfort' | 'frontier' | 'weakness' | 'exploration'

export const BUCKETS: readonly Bucket[] = ['comfort', 'frontier', 'weakness', 'exploration']

export interface Candidate {
  word: string
  bucket: Bucket
  cost: WordCost
  /** Rank of `cost.perTransitionMs` within the pool, in [0, 1]. */
  quantile: number
  /** How little is known about this word, from samples and exposure, in [0, 1]. */
  novelty: number
}

export interface PoolOptions {
  /** Share of the pool held aside as exploration, taken most novel first. */
  explorationShare?: number
  /** Share of the pool held aside as weakness, taken most concentrated first. */
  weaknessShare?: number
  /** Quantile below which a candidate is comfort rather than frontier. */
  comfortCeiling?: number
  /** Weight of transition samples against word exposure in the novelty score. */
  sampleWeight?: number
}

type PoolConfig = Required<PoolOptions>

const POOL_DEFAULTS: PoolConfig = {
  explorationShare: 0.2,
  weaknessShare: 0.2,
  comfortCeiling: 0.5,
  sampleWeight: 0.65,
}

/**
 * Prices every word for this player and sorts it into a bucket.
 *
 * Pass one length band at a time. An unconfident model files everything under
 * exploration, which is not a special case so much as the honest answer: with
 * no evidence there is no frontier to find, and the useful thing to do is
 * gather the evidence. It also means a first run behaves exactly as it did
 * before any of this existed.
 */
export function buildPool(
  words: readonly string[],
  model: SkillModel,
  exposure: Readonly<Record<string, number>>,
  options: PoolOptions = {},
): Candidate[] {
  const config = { ...POOL_DEFAULTS, ...options }

  const priced = words.map((word) => {
    const cost = model.cost(word)
    const seen = exposure[word] ?? 0
    const novelty = config.sampleWeight * cost.novelty + (1 - config.sampleWeight) / (1 + seen)
    return { word, cost, novelty }
  })

  if (!model.confident()) {
    return priced.map((p) => ({ ...p, bucket: 'exploration' as const, quantile: 0.5 }))
  }

  const byCost = [...priced].sort((a, b) => a.cost.perTransitionMs - b.cost.perTransitionMs)
  const quantiles = new Map<string, number>()
  const last = Math.max(1, byCost.length - 1)
  byCost.forEach((p, i) => quantiles.set(p.word, i / last))

  // Exploration is a share of the pool taken most novel first, and then only
  // the part of that share that is genuinely more novel than the pool's middle.
  //
  // The share alone is not enough. Novelty ties are common, and a plain rank cut
  // resolves them by array position, which quietly hands the bucket to whatever
  // happens to sit at the front of the corpus. The median test costs the bucket
  // nothing when there is real spread, and empties it when a player has met
  // everything equally often, which is the honest answer: there is nothing left
  // to explore, and the fallback chain will find them something else.
  const median = [...priced].map((p) => p.novelty).sort((a, b) => a - b)[
    Math.floor(priced.length / 2)
  ] ?? 0

  const explore = new Set(
    [...priced]
      .sort((a, b) => b.novelty - a.novelty)
      .slice(0, Math.round(priced.length * config.explorationShare))
      .filter((p) => p.novelty > median)
      .map((p) => p.word),
  )

  // Weakness is a bounded share taken by concentration, not every word that
  // happens to contain a weak pair.
  //
  // Taking all of them looks right and inverts the whole feature. Some pairs are
  // near-universal: `on` is in three quarters of the long band. Filing every one
  // of those words under weakness puts three quarters of the corpus behind the
  // anti-drill cap, so the other buckets can only draw from the quarter that
  // does not contain it, and a player weak at `on` ends up meeting it *less*
  // than a player who is fine at it. Measured at 21 percent against 78.
  //
  // Concentration is the honest reading of what a weakness word is. One weak
  // pair among a dozen transitions is an ordinary word. Three among six is a
  // lesson. Ranking by density and taking a fixed share means the bucket is a
  // deliberate boost on top of whatever the corpus was going to serve anyway,
  // which is what targeted practice should be.
  const density = (candidate: { word: string; cost: WordCost }): number =>
    candidate.cost.weaknesses.length / Math.max(1, candidate.word.length - 1)

  const weak = new Set(
    priced
      .filter((p) => p.cost.weaknesses.length > 0)
      .sort((a, b) => density(b) - density(a))
      .slice(0, Math.round(priced.length * config.weaknessShare))
      .map((p) => p.word),
  )

  // Weakness outranks exploration, which is not the obvious order and is worth
  // saying why. A weakness is a positive claim with sample counts behind it.
  // Exploration is the absence of one. Letting an unfamiliar word outrank a
  // known weakness means the material a player most needs is filed under "we
  // know nothing about this" purely because they have not met that particular
  // word yet, and the mix would then skip it whenever it asked for weakness.
  return priced.map((p) => {
    const quantile = quantiles.get(p.word) ?? 0.5
    const bucket: Bucket = weak.has(p.word)
      ? 'weakness'
      : explore.has(p.word)
        ? 'exploration'
        : quantile < config.comfortCeiling
          ? 'comfort'
          : 'frontier'
    return { ...p, quantile, bucket }
  })
}

export interface SelectionHistory {
  /** Words served recently, newest first. */
  recentWords: readonly string[]
  /** Weakness digram keys served recently. */
  recentDigrams: readonly string[]
  /** Words that may not be served at all, such as those already on screen. */
  excluded: ReadonlySet<string>
}

export const EMPTY_HISTORY: SelectionHistory = {
  recentWords: [],
  recentDigrams: [],
  excluded: new Set(),
}

export interface Selection {
  candidate: Candidate
  /** The bucket actually drawn from. */
  bucket: Bucket
  /** The bucket asked for, which differs when the first choice was empty. */
  requested: Bucket
}

export interface SelectOptions {
  /** Quantile the frontier aims at, from section 12's `[D50, D75]`. */
  frontierCentre?: number
  frontierWidth?: number
  /** Quantile a comfort word aims at. Not the easiest word, a pleasant one. */
  comfortCentre?: number
  /** Penalty for a word served recently. */
  repeatPenalty?: number
  /** Penalty for sharing an opening with a word served recently. */
  prefixPenalty?: number
  /** Penalty for each weakness digram trained recently. */
  drillPenalty?: number
  /** Characters compared when judging a shared opening. */
  prefixLength?: number
  /**
   * Random spread added to every score.
   *
   * Large on purpose, and the single most important number in this file.
   */
  jitter?: number
  /** Smallest shortlist, for a bucket with only a few words in it. */
  minShortlist?: number
  /** Share of the available bucket the shortlist covers. */
  shortlistShare?: number
}

type SelectConfig = Required<SelectOptions>

const SELECT_DEFAULTS: SelectConfig = {
  frontierCentre: 0.65,
  frontierWidth: 0.35,
  comfortCentre: 0.3,
  repeatPenalty: 1,
  prefixPenalty: 0.35,
  drillPenalty: 0.3,
  prefixLength: 2,
  jitter: 0.9,
  minShortlist: 6,
  shortlistShare: 0.35,
}

/**
 * Why the jitter is nearly as large as the whole fit range.
 *
 * The bucket does the targeting. Every word inside one is already appropriate
 * for the player and the moment, so what is wanted *within* a bucket is variety
 * rather than more precision. Fit is a bias toward the middle of the bucket's
 * intent, not a filter.
 *
 * Treating it as a filter measurably narrows the game. With fit dominating, an
 * eighty word band was served as sixty-two distinct words across six hundred
 * draws, with a top word at nearly four percent. Twenty-three words in the band
 * were never offered at all, which is the "it repeats the same words" complaint
 * from the first playtest arriving by a subtler route. Raising the spread takes
 * that to seventy-six distinct words and a top word under three, and the
 * frontier still lands where section 12 asks, because it is the bucket boundary
 * rather than the fit curve that was holding it there.
 */

/**
 * Order the sampler falls back through when a bucket has nothing to offer.
 *
 * Frontier sits in the middle of every chain, because it is the bucket that is
 * wrong by the smallest amount whichever direction the intended one lay in.
 */
const FALLBACK: Record<Bucket, readonly Bucket[]> = {
  comfort: ['comfort', 'exploration', 'frontier', 'weakness'],
  frontier: ['frontier', 'comfort', 'exploration', 'weakness'],
  weakness: ['weakness', 'frontier', 'exploration', 'comfort'],
  exploration: ['exploration', 'frontier', 'comfort', 'weakness'],
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** How well a candidate serves the bucket it was drawn for, in [0, 1]. */
function fit(candidate: Candidate, bucket: Bucket, config: SelectConfig): number {
  switch (bucket) {
    case 'frontier':
      return 1 - clamp01(Math.abs(candidate.quantile - config.frontierCentre) / config.frontierWidth)
    case 'comfort':
      return 1 - clamp01(Math.abs(candidate.quantile - config.comfortCentre) / config.comfortCentre)
    case 'exploration':
      return candidate.novelty
    case 'weakness': {
      // Diminishing, so a word stuffed with weak pairs does not dominate every
      // draw. Two is already a lesson, six is a tongue twister.
      const count = candidate.cost.weaknesses.length
      return count / (count + 1)
    }
  }
}

function penalty(candidate: Candidate, history: SelectionHistory, config: SelectConfig): number {
  let total = 0

  if (history.recentWords.includes(candidate.word)) total += config.repeatPenalty

  const opening = candidate.word.slice(0, config.prefixLength)
  if (history.recentWords.some((w) => w.startsWith(opening))) total += config.prefixPenalty

  for (const digram of candidate.cost.weaknesses) {
    if (history.recentDigrams.includes(digram)) total += config.drillPenalty
  }

  return total
}

/**
 * Draws one word for the requested bucket.
 *
 * Returns null only when every candidate is excluded, which the caller should
 * treat as "the arena already holds the corpus" rather than as an error.
 */
export function selectCandidate(
  pool: readonly Candidate[],
  requested: Bucket,
  history: SelectionHistory,
  random: () => number,
  options: SelectOptions = {},
): Selection | null {
  const config = { ...SELECT_DEFAULTS, ...options }

  for (const bucket of FALLBACK[requested]) {
    const available = pool.filter((c) => c.bucket === bucket && !history.excluded.has(c.word))
    if (available.length === 0) continue

    const scored = available
      .map((candidate) => ({
        candidate,
        score:
          fit(candidate, bucket, config) -
          penalty(candidate, history, config) +
          random() * config.jitter,
      }))
      .sort((a, b) => b.score - a.score)

    // The shortlist is a share of the bucket rather than a fixed count.
    //
    // Fit is a static property of a word, so the same few always win it. A
    // fixed shortlist of eight is reasonable for a small bucket and far too
    // selective for a large one, and the result was a corpus of eighty words
    // being served as about fifty. Scaling with the bucket keeps the targeting
    // while letting a big bucket breathe.
    const size = Math.max(
      Math.min(config.minShortlist, scored.length),
      Math.round(scored.length * config.shortlistShare),
    )
    const shortlist = scored.slice(0, size)

    // Triangular weights over the shortlist. The best fit is the most likely
    // and never the only one, which is what keeps a stable profile from
    // producing the same run twice.
    const weights = shortlist.map((_, i) => shortlist.length - i)
    const total = weights.reduce((sum, w) => sum + w, 0)
    let roll = random() * total

    for (let i = 0; i < shortlist.length; i++) {
      roll -= weights[i] as number
      if (roll <= 0) {
        return { candidate: (shortlist[i] as { candidate: Candidate }).candidate, bucket, requested }
      }
    }

    const fallback = shortlist[shortlist.length - 1] as { candidate: Candidate }
    return { candidate: fallback.candidate, bucket, requested }
  }

  return null
}
