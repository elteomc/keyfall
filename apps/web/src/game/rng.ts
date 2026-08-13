/**
 * Small deterministic generator. Runs are seeded so a session can be replayed
 * or shared later without any server involvement.
 */
export interface Rng {
  next(): number
  int(maxExclusive: number): number
  range(min: number, max: number): number
  pick<T>(items: readonly T[]): T
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  return {
    next,
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    range: (min, max) => min + next() * (max - min),
    pick: (items) => items[Math.floor(next() * items.length)]!,
  }
}
