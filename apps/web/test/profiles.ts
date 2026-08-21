import { type Profile, classifyDigram, emptyProfile } from '@keyfall/typing-core'

/**
 * A synthetic played-in profile.
 *
 * Enough structure that the skill model has something real to read: every
 * movement class has its own baseline, because everybody is slower on
 * same-finger pairs than on alternating ones, and `slow` names the pairs this
 * particular player is disproportionately bad at on top of that.
 */
const CLASS_MS: Record<string, number> = {
  repeat: 130,
  'same-finger': 230,
  'same-hand-row-change': 175,
  'same-hand-same-row': 150,
  'alternating-row-change': 145,
  'alternating-same-row': 130,
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('')

export interface TypistOptions {
  /** Digram like `pr` to how many times worse than their class the player is. */
  slow?: Record<string, number>
  samples?: number
  /** Scales every class, so a player can be slower overall without being weaker. */
  speed?: number
  /** Word to how many times it has been targeted. */
  exposure?: Record<string, number>
}

export function typistProfile(options: TypistOptions = {}): Profile {
  const { slow = {}, samples = 60, speed = 1, exposure = {} } = options
  const transitions: Profile['transitions'] = {}

  for (const from of LETTERS) {
    for (const to of LETTERS) {
      const kind = classifyDigram(from, to)
      if (!kind) continue
      transitions[`${from} ${to}`] = {
        meanMs: (CLASS_MS[kind] ?? 150) * speed * (slow[`${from}${to}`] ?? 1),
        samples,
        errors: 0,
      }
    }
  }

  return { ...emptyProfile(0), transitions, corpusExposure: exposure }
}

/** Spreads exposure across a word list so the exploration bucket has a signal. */
export function spreadExposure(words: readonly string[]): Record<string, number> {
  return Object.fromEntries(words.map((word, i) => [word, (i * 7) % 23]))
}
