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

export type LockedResolution =
  | { kind: 'hit'; typed: number; complete: boolean }
  | { kind: 'wrong'; expected: string }

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
export function resolveLockedKey(sequence: string, typed: number, key: string): LockedResolution {
  const expected = sequence[typed]
  if (expected === undefined) return { kind: 'wrong', expected: '' }
  if (key !== expected) return { kind: 'wrong', expected }

  const nextTyped = typed + 1
  return { kind: 'hit', typed: nextTyped, complete: nextTyped >= sequence.length }
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
