import type { Rng } from './rng'

/**
 * Curated corpus in three frequency bands.
 *
 * Milestone 0 only needs enough material to make targeting interesting. The
 * richer corpus with per-sequence metadata (digrams, difficulty estimates,
 * punctuation variants) belongs to the adaptive director in milestone 3.
 */
export type Band = 'short' | 'medium' | 'long'

export const CORPUS: Record<Band, readonly string[]> = {
  short: [
    'set', 'run', 'map', 'for', 'key', 'the', 'and', 'ask', 'row', 'tab',
    'net', 'job', 'fix', 'cut', 'log', 'add', 'end', 'far', 'get', 'put',
    'sum', 'box', 'cap', 'dry', 'gap', 'hub', 'ice', 'jam', 'lap', 'mix',
    'note', 'link', 'wave', 'form', 'call', 'push', 'span', 'edge', 'flag',
  ],
  medium: [
    'vector', 'matrix', 'signal', 'runtime', 'pattern', 'buffer', 'thread',
    'render', 'cursor', 'stream', 'anchor', 'filter', 'kernel', 'module',
    'packet', 'object', 'string', 'handle', 'update', 'window', 'travel',
    'proper', 'branch', 'primer', 'trigger', 'prefix', 'traffic', 'measure',
  ],
  long: [
    'probability', 'synchronization', 'distribution', 'optimization',
    'architecture', 'integration', 'environment', 'performance',
    'transaction', 'abstraction', 'consistency', 'implementation',
    'representation', 'configuration', 'transformation',
  ],
}

/**
 * Picks a word from a band, avoiding anything already on screen. Repeats are
 * boring and they also make prefix ambiguity unreadable.
 */
export function pickWord(band: Band, rng: Rng, exclude: ReadonlySet<string>): string {
  const pool = CORPUS[band]
  for (let attempt = 0; attempt < 12; attempt++) {
    const word = rng.pick(pool)
    if (!exclude.has(word)) return word
  }
  return rng.pick(pool)
}
