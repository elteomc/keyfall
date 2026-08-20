import type { Rng } from './rng'

/**
 * Curated corpus in three length bands.
 *
 * The bands are the game's difficulty lever: short words price reaction, long
 * ones price sustained accuracy. The per-sequence metadata the adaptive
 * director wants (digram coverage, difficulty estimates, punctuation variants)
 * still belongs to milestone 3.
 *
 * Size matters more than it looks. A six minute run destroys several hundred
 * words, so a small pool repeats within a single run, and repetition makes both
 * the material and the prefix ambiguity boring. It also biases the digram
 * statistics toward whatever happens to be in the pool.
 */
export type Band = 'short' | 'medium' | 'long'

export const CORPUS: Record<Band, readonly string[]> = {
  short: [
    'set', 'run', 'map', 'for', 'key', 'the', 'and', 'ask',
    'row', 'tab', 'net', 'job', 'fix', 'cut', 'log', 'add',
    'end', 'far', 'get', 'put', 'sum', 'box', 'cap', 'dry',
    'gap', 'hub', 'ice', 'jam', 'lap', 'mix', 'new', 'old',
    'own', 'pen', 'raw', 'sea', 'top', 'use', 'war', 'win',
    'bit', 'byte', 'call', 'code', 'copy', 'data', 'down', 'each',
    'edge', 'else', 'fact', 'fail', 'flag', 'flow', 'form', 'free',
    'from', 'gate', 'goto', 'half', 'hash', 'head', 'heap', 'hold',
    'hook', 'idle', 'into', 'item', 'join', 'jump', 'keep', 'kind',
    'last', 'leaf', 'left', 'line', 'link', 'list', 'load', 'lock',
    'long', 'loop', 'main', 'mark', 'mask', 'mode', 'more', 'move',
    'name', 'next', 'node', 'none', 'note', 'null', 'once', 'only',
    'open', 'over', 'pack', 'page', 'pair', 'park', 'part', 'pass',
    'path', 'peak', 'pick', 'pipe', 'plan', 'play', 'plus', 'poll',
    'pool', 'port', 'pull', 'push', 'read', 'real', 'rest', 'ring',
    'root', 'rule', 'safe', 'salt', 'save', 'scan', 'seed', 'seek',
    'send', 'show', 'side', 'sign', 'size', 'skip', 'slot', 'snap',
    'sort', 'span', 'spin', 'stop', 'swap', 'sync', 'tail', 'take',
    'task', 'team', 'tell', 'term', 'test', 'text', 'than', 'that',
    'them', 'then', 'they', 'this', 'tick', 'tide', 'time', 'tiny',
    'tone', 'tool', 'trap', 'tree', 'trim', 'true', 'tune', 'turn',
    'type', 'unit', 'upon', 'user', 'vary', 'very', 'view', 'void',
    'vote', 'wait', 'walk', 'wall', 'want', 'warm', 'wash', 'wave',
    'weak', 'wear', 'week', 'well', 'went', 'were', 'what', 'when',
    'whom', 'wide', 'wild', 'wind', 'wire', 'wise', 'wish', 'with',
    'word', 'work', 'wrap', 'year', 'your', 'zero', 'zone',
  ],
  medium: [
    'vector', 'matrix', 'signal', 'runtime', 'pattern', 'buffer', 'thread', 'render',
    'cursor', 'stream', 'anchor', 'filter', 'kernel', 'module', 'packet', 'object',
    'string', 'handle', 'update', 'window', 'travel', 'proper', 'branch', 'primer',
    'trigger', 'prefix', 'traffic', 'measure', 'access', 'action', 'active', 'adapter',
    'address', 'advance', 'almost', 'always', 'amount', 'append', 'around', 'assert',
    'assign', 'attach', 'attempt', 'author', 'backup', 'badge', 'banner', 'barrier',
    'basket', 'battery', 'beacon', 'before', 'behind', 'belong', 'better', 'beyond',
    'binary', 'binder', 'border', 'bottom', 'bracket', 'bridge', 'bright', 'broken',
    'bucket', 'budget', 'builder', 'bundle', 'button', 'camera', 'cancel', 'canvas',
    'carrier', 'center', 'change', 'charge', 'choice', 'circle', 'client', 'cluster',
    'column', 'combine', 'command', 'common', 'compact', 'compare', 'compile', 'complex',
    'compose', 'concept', 'concern', 'connect', 'console', 'contain', 'content', 'context',
    'control', 'convert', 'corner', 'counter', 'country', 'couple', 'create', 'credit',
    'crystal', 'current', 'custom', 'damage', 'danger', 'decide', 'declare', 'decline',
    'default', 'define', 'degree', 'deliver', 'density', 'depend', 'deploy', 'derive',
    'detail', 'detect', 'develop', 'device', 'digital', 'direct', 'display', 'divide',
    'domain', 'double', 'driver', 'during', 'dynamic',
  ],
  long: [
    'probability', 'synchronization', 'distribution', 'optimization', 'architecture', 'integration', 'environment', 'performance',
    'transaction', 'abstraction', 'consistency', 'implementation', 'representation', 'configuration', 'transformation', 'acceleration',
    'accessibility', 'accommodation', 'accountability', 'administration', 'amplification', 'anticipation', 'approximation', 'authentication',
    'authorization', 'characteristic', 'classification', 'collaboration', 'communication', 'compatibility', 'comprehension', 'concentration',
    'consideration', 'constitutional', 'demonstration', 'determination', 'differentiation', 'disproportionate', 'documentation', 'establishment',
    'experimental', 'generalization', 'identification', 'infrastructure', 'initialization', 'instrumentation', 'interpretation', 'investigation',
    'manufacturing', 'multiplication', 'naturalization', 'normalization', 'observational', 'operationalize', 'parallelization', 'particularly',
    'personalization', 'philosophical', 'predetermined', 'professional', 'pronunciation', 'qualification', 'quantification', 'recommendation',
    'reconciliation', 'redistribution', 'reinforcement', 'relationship', 'reorganization', 'responsibility', 'simplification', 'specialization',
    'specification', 'standardization', 'straightforward', 'substantially', 'transportation', 'understanding', 'visualization', 'vulnerability',
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
