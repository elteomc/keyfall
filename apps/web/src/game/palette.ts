import type { ComboTier } from '@keyfall/typing-core'

/**
 * Colours shared between the renderer and the effects system.
 *
 * They live apart from both so neither has to import the other for a constant.
 * Components rather than css strings, because effects fade everything they
 * draw and an alpha has to be pasted in per particle.
 */
export const TIER_RGB: Record<ComboTier, string> = {
  flat: '143, 214, 255',
  warm: '157, 242, 184',
  hot: '242, 198, 109',
  peak: '255, 157, 122',
}

/** Mistakes and breaches, the only two things the game says in red. */
export const ERROR_RGB = '255, 96, 96'
