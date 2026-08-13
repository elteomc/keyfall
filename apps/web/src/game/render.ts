import { ARENA_HEIGHT, ARENA_WIDTH, BASELINE_Y, type Enemy, type RunSession } from './session'

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
  hud: '#7b8aa3',
  hudStrong: '#e6edf7',
  error: 'rgba(255, 90, 90, 0.18)',
}

const FONT = '600 22px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

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
  return COLORS.drone
}

export function render(
  ctx: CanvasRenderingContext2D,
  session: RunSession,
  width: number,
  height: number,
  nowMs: number,
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = COLORS.background
  ctx.fillRect(0, 0, width, height)

  const view = viewportFor(width, height)
  ctx.setTransform(view.scale, 0, 0, view.scale, view.offsetX, view.offsetY)

  drawGrid(ctx)
  drawBaseline(ctx, session)
  drawBeams(ctx, session, nowMs)
  drawEnemies(ctx, session)
  drawHud(ctx, session)

  if (nowMs - session.lastErrorAtMs < 140) {
    ctx.fillStyle = COLORS.error
    ctx.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT)
  }
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

  const px = ARENA_WIDTH / 2
  const py = ARENA_HEIGHT - 34
  ctx.fillStyle = COLORS.player
  ctx.beginPath()
  ctx.moveTo(px, py - 18)
  ctx.lineTo(px + 15, py + 12)
  ctx.lineTo(px - 15, py + 12)
  ctx.closePath()
  ctx.fill()

  ctx.fillStyle = COLORS.hud
  ctx.font = '500 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  ctx.textAlign = 'center'
  const lives = '♥ '.repeat(Math.max(0, session.lives)).trim()
  ctx.fillText(lives, px, ARENA_HEIGHT - 6)
}

function drawBeams(ctx: CanvasRenderingContext2D, session: RunSession, nowMs: number): void {
  const px = ARENA_WIDTH / 2
  const py = ARENA_HEIGHT - 48
  ctx.lineWidth = 2
  for (const beam of session.beams) {
    const life = Math.max(0, (beam.untilMs - nowMs) / 90)
    ctx.strokeStyle = `rgba(143, 214, 255, ${0.55 * life})`
    ctx.beginPath()
    ctx.moveTo(px, py)
    ctx.lineTo(beam.x, beam.y)
    ctx.stroke()
  }
}

function drawEnemies(ctx: CanvasRenderingContext2D, session: RunSession): void {
  ctx.font = FONT
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  for (const enemy of session.enemies) {
    const isLocked = enemy.id === session.lockedId
    const isCandidate = session.prefix.length > 0 && enemy.word.startsWith(session.prefix)
    const highlight = isLocked ? enemy.typed : isCandidate ? session.prefix.length : 0

    const done = enemy.word.slice(0, highlight)
    const rest = enemy.word.slice(highlight)
    const width = ctx.measureText(enemy.word).width

    if (isLocked) {
      ctx.fillStyle = COLORS.locked
      ctx.beginPath()
      ctx.roundRect(enemy.x - width / 2 - 12, enemy.y - 20, width + 24, 40, 8)
      ctx.fill()
    }

    const doneWidth = ctx.measureText(done).width
    const restWidth = ctx.measureText(rest).width
    const left = enemy.x - (doneWidth + restWidth) / 2

    ctx.textAlign = 'left'
    ctx.fillStyle = isLocked ? COLORS.typed : COLORS.candidate
    ctx.fillText(done, left, enemy.y)
    ctx.fillStyle = enemyColor(enemy)
    ctx.fillText(rest, left + doneWidth, enemy.y)

    // A thin bar under a tank makes its length readable at a glance.
    if (enemy.kind === 'tank') {
      ctx.fillStyle = 'rgba(255, 157, 122, 0.35)'
      ctx.fillRect(left, enemy.y + 18, doneWidth + restWidth, 2)
    }
  }
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
