/**
 * Keyboard geometry, and the digram classes built on top of it.
 *
 * Section 6 of the technical plan asks for a hierarchical feature model,
 * because raw digrams alone are insufficient. A player types roughly six
 * hundred distinct digrams in a run and there are 676 of them in lowercase
 * alone, so a table keyed only on the pair stays sparse for a long time. The
 * fix is to let a digram fall back on the kind of movement it is, which is
 * something the player has done thousands of times by their second run.
 *
 * The classes are deliberately coarse. Section 6 lists eight features and this
 * uses five of them, because a class only helps if it is dense: splitting on
 * every feature at once would produce thirty buckets, each as sparse as the
 * digrams they were meant to rescue. Shift, punctuation and the number row are
 * absent because the v1 corpus is lowercase letters only. Pinky involvement is
 * left out for density, and reaches the model through the digram level instead.
 *
 * The layout is QWERTY with standard touch-typing fingering. Nothing else in
 * the codebase knows about physical keys, so a layout-aware version later
 * changes this file and no other.
 */

export type Hand = 'left' | 'right'

export interface KeyPosition {
  /** 0 top, 1 home, 2 bottom. */
  row: number
  /** Horizontal position including the row stagger, in key widths. */
  column: number
  hand: Hand
  /** 1 is the left pinky and 8 the right pinky. */
  finger: number
}

/**
 * How one key follows another.
 *
 * Ordered roughly worst to best, which is only a comment: nothing depends on
 * the order, because what each class actually costs is measured per player
 * rather than assumed.
 */
export type DigramClass =
  | 'repeat'
  | 'same-finger'
  | 'same-hand-row-change'
  | 'same-hand-same-row'
  | 'alternating-row-change'
  | 'alternating-same-row'

export const DIGRAM_CLASSES: readonly DigramClass[] = [
  'repeat',
  'same-finger',
  'same-hand-row-change',
  'same-hand-same-row',
  'alternating-row-change',
  'alternating-same-row',
]

const ROWS: readonly { keys: string; row: number; stagger: number }[] = [
  { keys: 'qwertyuiop', row: 0, stagger: 0 },
  { keys: 'asdfghjkl', row: 1, stagger: 0.25 },
  { keys: 'zxcvbnm', row: 2, stagger: 0.75 },
]

/** Standard fingering. Index fingers cover two columns each. */
const FINGERS: readonly { finger: number; keys: string }[] = [
  { finger: 1, keys: 'qaz' },
  { finger: 2, keys: 'wsx' },
  { finger: 3, keys: 'edc' },
  { finger: 4, keys: 'rtfgvb' },
  { finger: 5, keys: 'yuhjnm' },
  { finger: 6, keys: 'ik' },
  { finger: 7, keys: 'ol' },
  { finger: 8, keys: 'p' },
]

function buildLayout(): Map<string, KeyPosition> {
  const finger = new Map<string, number>()
  for (const group of FINGERS) {
    for (const key of group.keys) finger.set(key, group.finger)
  }

  const layout = new Map<string, KeyPosition>()
  for (const { keys, row, stagger } of ROWS) {
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i] as string
      const assigned = finger.get(key) ?? 0
      layout.set(key, {
        row,
        column: i + stagger,
        hand: assigned <= 4 ? 'left' : 'right',
        finger: assigned,
      })
    }
  }
  return layout
}

const LAYOUT = buildLayout()

/** Null for anything not on the lowercase letter layout. */
export function keyPosition(char: string): KeyPosition | null {
  return LAYOUT.get(char) ?? null
}

/**
 * Which class a transition belongs to.
 *
 * Null when either character is off the layout, so a caller skips unknown
 * material rather than filing it under a class it does not belong to.
 */
export function classifyDigram(from: string, to: string): DigramClass | null {
  const a = keyPosition(from)
  const b = keyPosition(to)
  if (!a || !b) return null

  if (from === to) return 'repeat'
  if (a.finger === b.finger) return 'same-finger'

  const sameRow = a.row === b.row
  if (a.hand === b.hand) return sameRow ? 'same-hand-same-row' : 'same-hand-row-change'
  return sameRow ? 'alternating-same-row' : 'alternating-row-change'
}

/**
 * Straight-line distance between two keys, in key widths.
 *
 * Unused by the current model, which measures rather than assumes. It exists
 * because a cold profile has nothing to measure, and a geometric prior is the
 * obvious thing to reach for when that becomes a problem worth solving.
 */
export function keyDistance(from: string, to: string): number | null {
  const a = keyPosition(from)
  const b = keyPosition(to)
  if (!a || !b) return null
  return Math.hypot(a.column - b.column, a.row - b.row)
}
