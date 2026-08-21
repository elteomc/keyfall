import { type DigramClass, classifyDigram } from '../src/keyboard'
import type { StoredTransition } from '../src/profile'

/**
 * A synthetic typist.
 *
 * Every class has its own baseline, because a real player is slower on
 * same-finger pairs than on alternating ones no matter how good they are, and a
 * model that cannot tell that apart from a personal weakness is the thing these
 * tests exist to rule out. `slow` names the pairs this particular typist is
 * disproportionately bad at, as a multiple of what their class predicts.
 */
export const CLASS_MS: Record<DigramClass, number> = {
  repeat: 130,
  'same-finger': 230,
  'same-hand-row-change': 175,
  'same-hand-same-row': 150,
  'alternating-row-change': 145,
  'alternating-same-row': 130,
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('')

export interface TypistOptions {
  /** Digram to how many times worse than their class this typist is. */
  slow?: Record<string, number>
  /** Digram to an absolute error rate. */
  errors?: Record<string, number>
  samples?: number
  /** Scales every class, so a whole typist can be slower without being weaker. */
  speed?: number
}

export function typist(options: TypistOptions = {}): Record<string, StoredTransition> {
  const { slow = {}, errors = {}, samples = 60, speed = 1 } = options
  const table: Record<string, StoredTransition> = {}

  for (const from of LETTERS) {
    for (const to of LETTERS) {
      const kind = classifyDigram(from, to)
      if (!kind) continue
      const pair = `${from}${to}`
      const errorRate = errors[pair] ?? 0
      table[`${from} ${to}`] = {
        meanMs: CLASS_MS[kind] * speed * (slow[pair] ?? 1),
        samples,
        errors: Math.round(samples * errorRate),
      }
    }
  }
  return table
}
