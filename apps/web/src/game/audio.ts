import type { ComboTier } from '@keyfall/typing-core'

import type { Feedback } from './session'

/**
 * The game's sound, synthesized on the spot.
 *
 * Every voice here is built from oscillators and one noise buffer. Nothing is
 * downloaded and nothing is decoded, so a keystroke can be heard on the frame
 * it was pressed, which is what section 7 of the product spec means by input
 * latency being the hardest constraint. It also keeps the runtime dependency
 * list at zero, as the build rules ask.
 *
 * Section 13 wants sound layers to align as cadence stabilizes. That is taken
 * literally: a keystroke is one voice at a low combo tier and up to three at
 * the top, and the random detune between them shrinks as the tier climbs, so
 * flow is something the player hears thickening rather than reads.
 */

const STORAGE_KEY = 'keyfall.muted'

const TIER_STEP: Record<ComboTier, number> = { flat: 0, warm: 1, hot: 2, peak: 3 }

/**
 * A pentatonic ladder in semitones. No two steps in it clash, so a player
 * typing ten characters a second cannot make the game sound wrong.
 */
const LADDER = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24]

const ROOT_HZ = 196

/** Quiet enough to sit under the room, since this plays for whole runs. */
const MASTER_GAIN = 0.22

function semitones(steps: number): number {
  return ROOT_HZ * 2 ** (steps / 12)
}

interface ToneSpec {
  type: OscillatorType
  hz: number
  /** Seconds from now. */
  delayS?: number
  durationS: number
  gain: number
  /** Slides to this frequency across the note, for sweeps. */
  endHz?: number
  detuneCents?: number
}

export class GameAudio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  private muted: boolean

  constructor() {
    this.muted = readStoredMute()
  }

  isMuted(): boolean {
    return this.muted
  }

  /**
   * Starts or wakes the audio device.
   *
   * Browsers refuse to make noise until a gesture, and the game already has
   * one: the Enter that begins a run. Nothing is constructed before then.
   */
  resume(): void {
    if (this.muted) return

    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return

      this.ctx = new Ctor({ latencyHint: 'interactive' })
      this.master = this.ctx.createGain()
      this.master.gain.value = MASTER_GAIN
      this.master.connect(this.ctx.destination)
      this.noise = whiteNoise(this.ctx)
    }

    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  toggleMute(): boolean {
    this.muted = !this.muted
    writeStoredMute(this.muted)

    if (this.muted) {
      void this.ctx?.suspend()
    } else {
      this.resume()
    }
    return this.muted
  }

  play(event: Feedback): void {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return

    const tier = TIER_STEP[event.tier]

    if (event.kind === 'hit') {
      this.hit(event.progress, tier)
      return
    }

    if (event.kind === 'kill') {
      this.kill(tier)
      return
    }

    if (event.kind === 'miss') {
      this.noiseBurst(0.13, 0.5, 900)
      this.tone({ type: 'square', hz: 92, durationS: 0.12, gain: 0.22, endHz: 66 })
      return
    }

    // A shielded breach should read as a save, not as a loss. Rising rather
    // than falling, and none of the noise a real breach carries.
    if (event.kind === 'shield') {
      this.tone({ type: 'triangle', hz: 220, durationS: 0.28, gain: 0.34, endHz: 660 })
      this.tone({ type: 'sine', hz: 440, durationS: 0.22, gain: 0.18, endHz: 880 })
      return
    }

    if (event.kind === 'breach') {
      this.noiseBurst(0.5, 0.35, 500)
      this.tone({ type: 'sine', hz: 150, durationS: 0.7, gain: 0.5, endHz: 48 })
      return
    }

    // A promotion, the one moment the combo is allowed to announce itself.
    this.tone({ type: 'triangle', hz: semitones(0), durationS: 0.45, gain: 0.3, endHz: semitones(24) })
    this.tone({ type: 'sine', hz: semitones(12), delayS: 0.04, durationS: 0.4, gain: 0.2, endHz: semitones(36) })
  }

  /**
   * One keystroke.
   *
   * Pitch climbs with progress through the word, so a word is a phrase that
   * resolves rather than a row of identical clicks, and finishing one is
   * audible before the kill sound confirms it.
   */
  private hit(progress: number, tier: number): void {
    const step = LADDER[Math.min(LADDER.length - 1, Math.floor(progress * LADDER.length))] ?? 0
    const jitter = (3 - tier) * 6

    this.tone({
      type: 'triangle',
      hz: semitones(step),
      durationS: 0.06,
      gain: 0.5,
      detuneCents: (Math.random() * 2 - 1) * jitter,
    })

    if (tier >= 2) {
      this.tone({
        type: 'sine',
        hz: semitones(step + 12),
        durationS: 0.05,
        gain: 0.26,
        detuneCents: (Math.random() * 2 - 1) * jitter,
      })
    }

    if (tier >= 3) {
      this.tone({ type: 'sine', hz: semitones(step + 19), durationS: 0.05, gain: 0.16 })
    }
  }

  /** A destroyed word, as a short arpeggio that opens up with the tier. */
  private kill(tier: number): void {
    const steps = [0, 4, 7, 12].slice(0, 3 + (tier >= 2 ? 1 : 0))
    steps.forEach((step, i) => {
      this.tone({
        type: 'triangle',
        hz: semitones(step + 12),
        delayS: i * 0.035,
        durationS: 0.16,
        gain: 0.34 - i * 0.04,
      })
    })
  }

  private tone(spec: ToneSpec): void {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master) return

    const at = ctx.currentTime + (spec.delayS ?? 0)
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = spec.type
    osc.frequency.setValueAtTime(spec.hz, at)
    if (spec.endHz !== undefined) osc.frequency.exponentialRampToValueAtTime(spec.endHz, at + spec.durationS)
    if (spec.detuneCents) osc.detune.setValueAtTime(spec.detuneCents, at)

    // Exponential ramps cannot touch zero, so the envelope starts and ends on
    // a value near silence instead. A linear attack would click.
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(spec.gain, at + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + spec.durationS)

    osc.connect(gain)
    gain.connect(master)
    osc.start(at)
    osc.stop(at + spec.durationS + 0.02)
    osc.onended = () => gain.disconnect()
  }

  private noiseBurst(durationS: number, gainValue: number, cutoffHz: number): void {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master || !this.noise) return

    const at = ctx.currentTime
    const source = ctx.createBufferSource()
    const filter = ctx.createBiquadFilter()
    const gain = ctx.createGain()

    source.buffer = this.noise
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(cutoffHz, at)

    gain.gain.setValueAtTime(gainValue, at)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + durationS)

    source.connect(filter)
    filter.connect(gain)
    gain.connect(master)
    source.start(at)
    source.stop(at + durationS)
    source.onended = () => gain.disconnect()
  }
}

function whiteNoise(ctx: AudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate)
  const channel = buffer.getChannelData(0)
  for (let i = 0; i < channel.length; i++) channel[i] = Math.random() * 2 - 1
  return buffer
}

/** Settings are lightweight, so they belong in localStorage per the technical plan. */
function readStoredMute(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function writeStoredMute(muted: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(muted))
  } catch {
    // A browser that refuses storage still gets to play, it just forgets.
  }
}
