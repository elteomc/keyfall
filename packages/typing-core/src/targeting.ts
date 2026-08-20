/**
 * Prefix-lock targeting.
 *
 * While no target is locked, typed characters accumulate into a prefix. The
 * prefix locks a target as soon as it matches exactly one active sequence.
 * Ambiguity is a mechanic, not a bug: resolving `their` against `there` is
 * part of the skill being trained.
 */

export interface TargetCandidate {
  id: string
  sequence: string
}

export type UnlockedResolution =
  /** The prefix now identifies exactly one target. `typed` counts the prefix. */
  | { kind: 'lock'; targetId: string; typed: number; prefix: string }
  /** Several targets still share the prefix. Keep typing. */
  | { kind: 'ambiguous'; prefix: string; candidateIds: string[] }
  /** No active sequence starts with this prefix. The prefix resets. */
  | { kind: 'miss'; prefix: '' }

/**
 * What a wrong key does to progress already made on the locked target.
 *
 * `advance` moves the cursor past the mistake, exactly as a typing test scores
 * a substitution. The character is recorded wrong and the word carries on, so a
 * slip costs accuracy and combo but not time.
 *
 * This matters more than it sounds. Holding the cursor still on a wrong key
 * assumes the player stops dead and resumes from the character the game is
 * waiting for, and nobody types like that. A fast typist has already sent the
 * next two keys, and each of them was then charged as another error. One slip
 * in `packet` produced three wrong-key sounds on a word typed almost perfectly.
 *
 * `reset` is the shield rule from section 3.4, where a wrong key sends the
 * player back to the start. Keeping this a parameter keeps the rule with the
 * archetype that owns it rather than scattering enemy cases through the
 * session.
 */
export type ErrorPolicy = 'advance' | 'reset'

export type LockedResolution =
  | { kind: 'hit'; typed: number; complete: boolean }
  /**
   * `typed` is where the cursor sits after the mistake, and `complete` is set
   * when the mistake was the last character, so a slip cannot strand a word one
   * key from death.
   */
  | { kind: 'wrong'; expected: string; typed: number; complete: boolean }

/** Apply one character while no target is locked. */
export function resolveUnlockedKey(
  candidates: readonly TargetCandidate[],
  prefix: string,
  key: string,
): UnlockedResolution {
  const next = prefix + key
  const matches = candidates.filter((c) => c.sequence.startsWith(next))

  if (matches.length === 0) return { kind: 'miss', prefix: '' }

  // A completed word wins over a longer word that merely starts the same way.
  // Without this, `run` becomes unkillable whenever `runtime` is on screen.
  const exact = matches.find((c) => c.sequence === next)
  if (exact) return { kind: 'lock', targetId: exact.id, typed: next.length, prefix: next }

  if (matches.length === 1) {
    return { kind: 'lock', targetId: matches[0]!.id, typed: next.length, prefix: next }
  }
  return { kind: 'ambiguous', prefix: next, candidateIds: matches.map((c) => c.id) }
}

/** Apply one character to the locked target. */
export function resolveLockedKey(
  sequence: string,
  typed: number,
  key: string,
  policy: ErrorPolicy = 'advance',
): LockedResolution {
  const expected = sequence[typed]

  // Past the end of the word. Nothing survives and nothing completes.
  if (expected === undefined) return { kind: 'wrong', expected: '', typed, complete: false }

  if (key !== expected) {
    if (policy === 'reset') return { kind: 'wrong', expected, typed: 0, complete: false }
    const nextTyped = typed + 1
    return { kind: 'wrong', expected, typed: nextTyped, complete: nextTyped >= sequence.length }
  }

  const nextTyped = typed + 1
  return { kind: 'hit', typed: nextTyped, complete: nextTyped >= sequence.length }
}

/**
 * How much of a word a mistake wasted, in [0, 1].
 *
 * A slip on the first character spoils the whole word, a slip on the last
 * spoils almost none of it, so the two should not cost the same. The caller
 * turns this into a penalty.
 */
export function errorSeverity(sequenceLength: number, index: number): number {
  if (sequenceLength <= 0) return 1
  const remaining = sequenceLength - index
  return Math.min(1, Math.max(0, remaining / sequenceLength))
}

/**
 * Shortest prefix that identifies a target uniquely among the candidates.
 * Returns the whole sequence when nothing distinguishes it.
 */
export function distinguishingPrefix(
  candidates: readonly TargetCandidate[],
  id: string,
): string | null {
  const target = candidates.find((c) => c.id === id)
  if (!target) return null

  const others = candidates.filter((c) => c.id !== id)
  for (let n = 1; n <= target.sequence.length; n++) {
    const prefix = target.sequence.slice(0, n)
    if (!others.some((c) => c.sequence.startsWith(prefix))) return prefix
  }
  return target.sequence
}
