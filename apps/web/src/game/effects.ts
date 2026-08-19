import type { Feedback } from './session'
import { ERROR_RGB, TIER_RGB } from './palette'

/**
 * The visual side of hit feel.
 *
 * Section 13 of the game design asks that every keystroke drive a small
 * animation and that particle intensity grow as cadence stabilizes, so the
 * player feels flow instead of reading it. That is the whole job here: sparks
 * on a correct key, a burst and a ring on a kill, red on a mistake, and a
 * shove on a breach.
 *
 * The system is fed the session's feedback queue and knows nothing else about
 * the game. It owns no canvas state beyond what it draws, and it is pure
 * enough to test without a browser.
 */

export interface EffectsOptions {
  /**
   * Honours `prefers-reduced-motion`. Screen shake stops entirely and the
   * particle counts drop, but nothing goes silent: feedback the player relies
   * on to read their own typing is not a motion effect.
   */
  reducedMotion?: boolean
  /** Ceiling on live particles, so a long run at peak tier cannot cost frames. */
  maxParticles?: number
}

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  ageMs: number
  lifeMs: number
  size: number
  rgb: string
}

interface Ring {
  x: number
  y: number
  radius: number
  ageMs: number
  lifeMs: number
  width: number
  rgb: string
}

/** Sparks fall, which makes them read as debris rather than as decoration. */
const GRAVITY = 260
const DRAG_PER_SECOND = 1.8

/** How fast a shove decays. Short, because a lingering wobble reads as lag. */
const SHAKE_HALF_LIFE_MS = 70

const TIER_SPARKS: Record<string, number> = { flat: 3, warm: 4, hot: 6, peak: 8 }

export class Effects {
  private readonly reducedMotion: boolean
  private readonly maxParticles: number
  private particles: Particle[] = []
  private rings: Ring[] = []
  private shake = 0
  private offsetX = 0
  private offsetY = 0

  constructor(options: EffectsOptions = {}) {
    this.reducedMotion = options.reducedMotion ?? false
    this.maxParticles = options.maxParticles ?? 360
  }

  /** Drops everything, for the start of a run. */
  clear(): void {
    this.particles = []
    this.rings = []
    this.shake = 0
    this.offsetX = 0
    this.offsetY = 0
  }

  particleCount(): number {
    return this.particles.length
  }

  /** The frame's camera offset, already computed in `update`. */
  shakeOffset(): { x: number; y: number } {
    return { x: this.offsetX, y: this.offsetY }
  }

  push(event: Feedback): void {
    const tint = TIER_RGB[event.tier]

    if (event.kind === 'hit') {
      // Intensity rises with the tier, which is the design's "particle
      // intensity grows" and the only place the combo is visible mid-word.
      this.sparks(event.x, event.y, this.scaled(TIER_SPARKS[event.tier] ?? 3), 120, tint, 1.6)
      return
    }

    if (event.kind === 'kill') {
      this.sparks(event.x, event.y, this.scaled(18), 230, tint, 2.2)
      this.ring(event.x, event.y, 52, 320, 2, tint)
      this.shove(2.5)
      return
    }

    if (event.kind === 'miss') {
      this.sparks(event.x, event.y, this.scaled(7), 200, ERROR_RGB, 1.8)
      this.shove(3)
      return
    }

    if (event.kind === 'breach') {
      this.sparks(event.x, event.y, this.scaled(22), 420, ERROR_RGB, 2.6)
      this.ring(event.x, event.y, 120, 460, 3, ERROR_RGB)
      this.shove(11)
      return
    }

    // A promotion is the one moment the game is allowed to be loud about the
    // combo, so it gets a ring off the player rather than off a target.
    this.ring(event.x, event.y, 150, 620, 2.5, tint)
  }

  update(dtMs: number): void {
    const dt = dtMs / 1000
    const drag = Math.max(0, 1 - DRAG_PER_SECOND * dt)

    for (const p of this.particles) {
      p.ageMs += dtMs
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.vy += GRAVITY * dt
      p.vx *= drag
      p.vy *= drag
    }
    this.particles = this.particles.filter((p) => p.ageMs < p.lifeMs)

    for (const r of this.rings) r.ageMs += dtMs
    this.rings = this.rings.filter((r) => r.ageMs < r.lifeMs)

    this.shake *= Math.exp(-dtMs / SHAKE_HALF_LIFE_MS)
    if (this.shake < 0.05) this.shake = 0
    this.offsetX = this.shake === 0 ? 0 : (Math.random() * 2 - 1) * this.shake
    this.offsetY = this.shake === 0 ? 0 : (Math.random() * 2 - 1) * this.shake
  }

  draw(ctx: CanvasRenderingContext2D): void {
    for (const r of this.rings) {
      const life = r.ageMs / r.lifeMs
      // Eased outward, so the ring leaves fast and settles, like a shockwave.
      const radius = r.radius * (1 - (1 - life) ** 2)
      ctx.strokeStyle = `rgba(${r.rgb}, ${0.5 * (1 - life)})`
      ctx.lineWidth = r.width
      ctx.beginPath()
      ctx.arc(r.x, r.y, radius, 0, Math.PI * 2)
      ctx.stroke()
    }

    for (const p of this.particles) {
      const life = p.ageMs / p.lifeMs
      ctx.fillStyle = `rgba(${p.rgb}, ${1 - life})`
      const size = p.size * (1 - life * 0.6)
      ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size)
    }
  }

  /** Reduced motion halves the debris rather than removing it. */
  private scaled(count: number): number {
    return this.reducedMotion ? Math.max(1, Math.round(count / 2)) : count
  }

  private sparks(
    x: number,
    y: number,
    count: number,
    lifeMs: number,
    rgb: string,
    size: number,
  ): void {
    const room = this.maxParticles - this.particles.length
    for (let i = 0; i < Math.min(count, room); i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = 40 + Math.random() * 150
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 30,
        ageMs: 0,
        lifeMs: lifeMs * (0.7 + Math.random() * 0.6),
        size,
        rgb,
      })
    }
  }

  private ring(x: number, y: number, radius: number, lifeMs: number, width: number, rgb: string): void {
    this.rings.push({ x, y, radius, ageMs: 0, lifeMs, width, rgb })
  }

  private shove(magnitude: number): void {
    if (this.reducedMotion) return
    this.shake = Math.max(this.shake, magnitude)
  }
}
