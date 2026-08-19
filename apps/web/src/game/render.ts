import type { Effects } from './effects'
import { TIER_RGB } from './palette'
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  BASELINE_Y,
  PLAYER_X,
  PLAYER_Y,
  REVEAL_Y,
  type Enemy,
  type RunSession,
} from './session'

const COLORS = {
  background: '#080b12',
  grid: 'rgba(120, 160, 220, 0.05)',
  baseline: 'rgba(120, 200, 255, 0.35)',
  player: '#8fd6ff',
  pending: '#7b8aa3',
  typed: '#8fd6ff',
  candidate: '#f2c66d',
  locked: 'rgba(143, 214, 255, 0.16)',
  tank: '#ff9d7a',
  swarm: '#9df2b8',
  drone: '#c9d6ea',
  sprinter: '#b9a7ff',
  shield: '#7fe3d4',
  hud: '#7b8aa3',
  hudStrong: '#e6edf7',
  error: 'rgba(255, 90, 90, 0.18)',
}

const FONT = '600 22px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** How far above the arena the fade-in begins, in arena units. */
const FADE_START = 30

const TIER_FLASH_MS = 1000

/**
 * How much the arena glows at each tier.
 *
 * This is the "subtle screen energy" of section 13, and subtle is the whole
 * specification: the top tier is a faint warm edge, not a light show. Combo
 * tier is shown as colour, never as a number, so this and the marker are how
 * flow is felt without reading anything.
 */
const TIER_GLOW = { flat: 0, warm: 0.05, hot: 0.1, peak: 0.16 }

/** A hit brightens the glow for a moment, so the arena breathes with the typing. */
const GLOW_PULSE_MS = 220

/** How long a struck word keeps recoiling. */
const HIT_FLINCH_MS = 110

interface Viewport {
  scale: number
  offsetX: number
  offsetY: number
}

function viewportFor(width: number, height: number): Viewport {
  const scale = Math.min(width / ARENA_WIDTH, height / ARENA_HEIGHT)
  return {
    scale,
    offsetX: (width - ARENA_WIDTH * scale) / 2,
    offsetY: (height - ARENA_HEIGHT * scale) / 2,
  }
}

function enemyColor(enemy: Enemy): string {
  if (enemy.kind === 'tank') return COLORS.tank
  if (enemy.kind === 'swarm') return COLORS.swarm
  if (enemy.kind === 'sprinter') return COLORS.sprinter
  if (enemy.kind === 'shield') return COLORS.shield
  return COLORS.drone
}

export function render(
  ctx: CanvasRenderingContext2D,
  session: RunSession,
  effects: Effects,
  width: number,
  height: number,
  nowMs: number,
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = COLORS.background
  ctx.fillRect(0, 0, width, height)

  const view = viewportFor(width, height)
  const shake = effects.shakeOffset()
  ctx.setTransform(
    view.scale,
    0,
    0,
    view.scale,
    view.offsetX + shake.x * view.scale,
    view.offsetY + shake.y * view.scale,
  )

  // Everything is clipped to the arena rect. Enemies start above the top edge,
  // and without this they would draw into the letterboxed margin.
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, ARENA_WIDTH, ARENA_HEIGHT)
  ctx.clip()

  drawGrid(ctx)
  drawBaseline(ctx, session)
  drawBeams(ctx, session, nowMs)
  drawEnemies(ctx, session, nowMs)
  effects.draw(ctx)
  drawGlow(ctx, session, nowMs)
  drawTierFlash(ctx, session, nowMs)
  drawHud(ctx, session)

  if (nowMs - session.lastErrorAtMs < 140) {
    ctx.fillStyle = COLORS.error
    ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT)
  }

  ctx.restore()
}

/**
 * A glow around the edges of the arena, in the tier's colour.
 *
 * Drawn as a radial gradient that is transparent in the middle, so it never
 * competes with the words the player is reading. It brightens for a moment on
 * every hit, which is what makes a clean streak feel like it is charging.
 */
function drawGlow(ctx: CanvasRenderingContext2D, session: RunSession, nowMs: number): void {
  const tier = session.comboTier()
  const base = TIER_GLOW[tier]
  if (base <= 0) return

  const sinceHit = nowMs - session.lastHitAtMs
  const pulse = sinceHit >= 0 && sinceHit < GLOW_PULSE_MS ? 1 - sinceHit / GLOW_PULSE_MS : 0
  const strength = base * (1 + 0.6 * pulse)

  const gradient = ctx.createRadialGradient(
    ARENA_WIDTH / 2,
    ARENA_HEIGHT / 2,
    ARENA_HEIGHT * 0.35,
    ARENA_WIDTH / 2,
    ARENA_HEIGHT / 2,
    ARENA_WIDTH * 0.72,
  )
  gradient.addColorStop(0, `rgba(${TIER_RGB[tier]}, 0)`)
  gradient.addColorStop(1, `rgba(${TIER_RGB[tier]}, ${strength})`)

  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT)
}

/** Opacity ramp that ends exactly where an enemy becomes targetable. */
function revealAlpha(enemy: Enemy): number {
  const span = REVEAL_Y + FADE_START
  const progress = Math.min(1, Math.max(0, (enemy.y + FADE_START) / span))
  return 0.15 + 0.85 * progress
}

function drawGrid(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle = COLORS.grid
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let x = 0; x <= ARENA_WIDTH; x += 50) {
    ctx.moveTo(x, 0)
    ctx.lineTo(x, ARENA_HEIGHT)
  }
  for (let y = 0; y <= ARENA_HEIGHT; y += 50) {
    ctx.moveTo(0, y)
    ctx.lineTo(ARENA_WIDTH, y)
  }
  ctx.stroke()
}

function drawBaseline(ctx: CanvasRenderingContext2D, session: RunSession): void {
  ctx.strokeStyle = COLORS.baseline
  ctx.lineWidth = 2
  ctx.setLineDash([10, 12])
  ctx.beginPath()
  ctx.moveTo(40, BASELINE_Y)
  ctx.lineTo(ARENA_WIDTH - 40, BASELINE_Y)
  ctx.stroke()
  ctx.setLineDash([])

  ctx.fillStyle = `rgb(${TIER_RGB[session.comboTier()]})`
  ctx.beginPath()
  ctx.moveTo(PLAYER_X, PLAYER_Y - 4)
  ctx.lineTo(PLAYER_X + 15, PLAYER_Y + 26)
  ctx.lineTo(PLAYER_X - 15, PLAYER_Y + 26)
  ctx.closePath()
  ctx.fill()

  ctx.fillStyle = COLORS.hud
  ctx.font = '500 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  ctx.textAlign = 'center'
  const lives = '♥ '.repeat(Math.max(0, session.lives)).trim()
  ctx.fillText(lives, PLAYER_X, ARENA_HEIGHT - 6)
}

function drawBeams(ctx: CanvasRenderingContext2D, session: RunSession, nowMs: number): void {
  const rgb = TIER_RGB[session.comboTier()]
  ctx.lineWidth = 2
  for (const beam of session.beams) {
    const life = Math.max(0, (beam.untilMs - nowMs) / 90)
    ctx.strokeStyle = `rgba(${rgb}, ${0.55 * life})`
    ctx.beginPath()
    ctx.moveTo(PLAYER_X, PLAYER_Y)
    ctx.lineTo(beam.x, beam.y)
    ctx.stroke()
  }
}

function drawEnemies(ctx: CanvasRenderingContext2D, session: RunSession, nowMs: number): void {
  ctx.font = FONT
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  for (const enemy of session.enemies) {
    ctx.globalAlpha = revealAlpha(enemy)
    const isLocked = enemy.id === session.lockedId
    const isCandidate = session.prefix.length > 0 && enemy.word.startsWith(session.prefix)
    const highlight = isLocked ? enemy.typed : isCandidate ? session.prefix.length : 0

    // The struck word recoils and flares for a moment. This is the enemy hit
    // response of section 13, and it is what makes a key feel like it landed
    // on something rather than merely advancing a counter.
    const sinceHit = nowMs - enemy.hitAtMs
    const flinch = sinceHit >= 0 && sinceHit < HIT_FLINCH_MS ? 1 - sinceHit / HIT_FLINCH_MS : 0
    const y = enemy.y - flinch * 3

    const done = enemy.word.slice(0, highlight)
    const rest = enemy.word.slice(highlight)
    const width = ctx.measureText(enemy.word).width

    if (isLocked) {
      ctx.fillStyle = COLORS.locked
      ctx.beginPath()
      ctx.roundRect(enemy.x - width / 2 - 12, y - 20, width + 24, 40, 8)
      ctx.fill()
    }

    const doneWidth = ctx.measureText(done).width
    const restWidth = ctx.measureText(rest).width
    const left = enemy.x - (doneWidth + restWidth) / 2

    ctx.textAlign = 'left'
    ctx.fillStyle = flinch > 0 ? COLORS.hudStrong : isLocked ? COLORS.typed : COLORS.candidate
    ctx.fillText(done, left, y)
    ctx.fillStyle = enemyColor(enemy)
    ctx.fillText(rest, left + doneWidth, y)

    drawArchetypeMark(ctx, enemy, left, doneWidth + restWidth, y)
  }

  ctx.globalAlpha = 1
}

/**
 * A silhouette per archetype, so the player knows what a word will demand
 * before reading a single character of it.
 */
function drawArchetypeMark(
  ctx: CanvasRenderingContext2D,
  enemy: Enemy,
  left: number,
  width: number,
  y: number,
): void {
  if (enemy.kind === 'tank') {
    // A bar under the longest words, making their length readable at a glance.
    ctx.fillStyle = 'rgba(255, 157, 122, 0.35)'
    ctx.fillRect(left, y + 18, width, 2)
    return
  }

  if (enemy.kind === 'shield') {
    // An outline that closes as the word is typed. One wrong key opens it
    // again, which is the rule this archetype exists to teach.
    ctx.strokeStyle = 'rgba(127, 227, 212, 0.5)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.roundRect(left - 9, y - 17, width + 18, 34, 7)
    ctx.stroke()

    const held = enemy.word.length === 0 ? 0 : enemy.typed / enemy.word.length
    if (held > 0) {
      ctx.strokeStyle = 'rgba(127, 227, 212, 0.95)'
      ctx.beginPath()
      ctx.moveTo(left - 9, y + 17)
      ctx.lineTo(left - 9 + (width + 18) * held, y + 17)
      ctx.stroke()
    }
    return
  }

  if (enemy.kind === 'sprinter') {
    // A trail above it, pointing back the way it came.
    ctx.strokeStyle = 'rgba(185, 167, 255, 0.4)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(enemy.x, y - 20)
    ctx.lineTo(enemy.x, y - 34)
    ctx.moveTo(enemy.x - 7, y - 24)
    ctx.lineTo(enemy.x - 7, y - 32)
    ctx.moveTo(enemy.x + 7, y - 24)
    ctx.lineTo(enemy.x + 7, y - 32)
    ctx.stroke()
  }
}

function drawTierFlash(
  ctx: CanvasRenderingContext2D,
  session: RunSession,
  nowMs: number,
): void {
  const tier = session.promotedTier
  if (!tier) return

  const age = nowMs - session.tierPromotedAtMs
  if (age < 0 || age > TIER_FLASH_MS) return

  const fade = 1 - age / TIER_FLASH_MS
  ctx.globalAlpha = fade
  ctx.fillStyle = `rgb(${TIER_RGB[tier]})`
  ctx.font = '600 15px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  // Rises slightly as it fades, so it reads as a release rather than a label.
  ctx.fillText(tier.toUpperCase(), ARENA_WIDTH / 2, ARENA_HEIGHT - 58 - (1 - fade) * 10)
  ctx.globalAlpha = 1
}

function drawHud(ctx: CanvasRenderingContext2D, session: RunSession): void {
  ctx.font = '500 15px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'

  const seconds = Math.floor(session.elapsedMs / 1000)
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

  ctx.fillStyle = COLORS.hudStrong
  ctx.fillText(String(session.score), 32, 44)
  ctx.fillStyle = COLORS.hud
  ctx.fillText('score', 32, 64)

  ctx.textAlign = 'right'
  ctx.fillStyle = COLORS.hudStrong
  ctx.fillText(`${session.liveWpm().toFixed(0)} wpm`, ARENA_WIDTH - 32, 44)
  ctx.fillStyle = COLORS.hud
  ctx.fillText(clock, ARENA_WIDTH - 32, 64)
}
