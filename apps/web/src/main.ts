import './style.css'
import { type Profile, beatenBests, emptyProfile, exportProfile, recordRun } from '@keyfall/typing-core'
import { GameAudio } from './game/audio'
import { Effects } from './game/effects'
import { render } from './game/render'
import { RunSession } from './game/session'
import { type ProfileStore, createMemoryStore, createProfileStore, importInto } from './game/storage'
import { renderOverlay } from './ui/overlay'

const canvasElement = document.querySelector<HTMLCanvasElement>('#arena')
const overlayElement = document.querySelector<HTMLElement>('#overlay')
if (!canvasElement || !overlayElement) throw new Error('arena or overlay element missing')

const context = canvasElement.getContext('2d', { alpha: false })
if (!context) throw new Error('2d canvas context unavailable')

const canvas = canvasElement
const overlay = overlayElement
const ctx = context

const session = new RunSession()
const audio = new GameAudio()
const effects = new Effects({
  reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
})
let lastFrameMs = performance.now()
let overlayPhase: string | null = null

/**
 * The stored profile.
 *
 * Held in memory until IndexedDB answers, so the first run is playable before
 * storage is ready and a browser that refuses storage entirely still plays.
 * `store.durable` is what the overlay reads to avoid promising a history that
 * will not survive a reload.
 */
let store: ProfileStore = createMemoryStore(Date.now())
let profile: Profile = emptyProfile(Date.now())
let runStartedAtMs = Date.now()
/** Personal bests the finished run beat, read before it was folded in. */
let beaten: string[] = []

void (async () => {
  store = await createProfileStore(Date.now())
  profile = await store.load()
  if (session.phase !== 'playing') renderOverlay(overlay, session, { profile, durable: store.durable, beaten })
})()

/**
 * Folds the finished run into the profile.
 *
 * Bests are read before the fold, so the summary can say what was beaten by
 * this run rather than what the profile happens to hold afterwards.
 */
async function keepRun(): Promise<void> {
  const contribution = session.contribution(runStartedAtMs)
  if (contribution === null) return

  beaten = beatenBests(profile.bests, contribution.record)
  profile = recordRun(profile, contribution, Date.now())

  // The overlay is already on screen, so it is redrawn once the record lands.
  renderOverlay(overlay, session, { profile, durable: store.durable, beaten })

  await store.save(profile)
  await store.saveEvents(contribution.record.runId, session.events())
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

function pickFile(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'application/json'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    const imported = await importInto(store, await file.text())
    if (imported === null) {
      window.alert('That file is not a Keyfall profile.')
      return
    }
    profile = imported
    renderOverlay(overlay, session, { profile, durable: store.durable, beaten })
  }
  input.click()
}

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.floor(window.innerWidth * dpr)
  canvas.height = Math.floor(window.innerHeight * dpr)
}

function frame(nowMs: number): void {
  // A clamped delta keeps a backgrounded tab from teleporting every enemy
  // through the baseline the moment it comes back.
  const dtMs = Math.min(nowMs - lastFrameMs, 100)
  lastFrameMs = nowMs

  if (!document.hidden) {
    session.update(nowMs, dtMs)

    // Drained once per frame rather than handled on the keystroke, so nothing
    // in the audio or particle path can ever sit between a key and its effect
    // on the game state.
    for (const event of session.drainFeedback()) {
      audio.play(event)
      effects.push(event)
    }
    effects.update(dtMs)
  }

  render(ctx, session, effects, canvas.width, canvas.height, nowMs)

  if (session.phase !== overlayPhase) {
    const ended = overlayPhase === 'playing' && session.phase === 'over'
    overlayPhase = session.phase
    renderOverlay(overlay, session, { profile, durable: store.durable, beaten })
    // Persistence is deliberately off the frame path. The summary is on screen
    // before anything is written, so a slow or failing write costs the player
    // nothing but a history entry.
    if (ended) void keepRun()
  }

  requestAnimationFrame(frame)
}

function isTypingKey(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey
}

window.addEventListener('keydown', (event) => {
  const nowMs = performance.now()

  // Ctrl is deliberate: every unmodified printable key belongs to the game, so
  // a settings shortcut cannot be one.
  if (event.key.toLowerCase() === 'm' && event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault()
    audio.toggleMute()
    return
  }

  // Data controls live off the title and summary screens only. Section 15 wants
  // the player able to see and remove what the game keeps, and mid-run is the
  // one moment a confirm dialog must never appear.
  if (session.phase !== 'playing' && event.ctrlKey && !event.metaKey && !event.altKey) {
    const key = event.key.toLowerCase()

    if (key === 'e') {
      event.preventDefault()
      download('keyfall-profile.json', exportProfile(profile))
      return
    }

    if (key === 'o') {
      event.preventDefault()
      pickFile()
      return
    }

    if (key === 'backspace' || event.key === 'Delete') {
      event.preventDefault()
      if (!window.confirm('Erase every stored run and statistic? This cannot be undone.')) return
      void (async () => {
        await store.clear()
        profile = await store.load()
        beaten = []
        renderOverlay(overlay, session, { profile, durable: store.durable, beaten })
      })()
      return
    }
  }

  if (session.phase !== 'playing') {
    // Enter is the only restart key. Space would restart on a keystroke the
    // player had already sent, skipping the summary of the run they just lost.
    if (event.key === 'Enter') {
      event.preventDefault()
      lastFrameMs = nowMs
      // Browsers only allow audio to start from a gesture, and this is the
      // gesture the game already has.
      audio.resume()
      effects.clear()
      runStartedAtMs = Date.now()
      beaten = []
      session.start(nowMs)
      renderOverlay(overlay, session, { profile, durable: store.durable, beaten })
      overlayPhase = session.phase
    }
    return
  }

  if (event.key === 'Escape') {
    session.cancelLock(nowMs)
    return
  }

  if (!isTypingKey(event)) return
  event.preventDefault()
  session.key(event.key, nowMs)
})

// Coming back from another window should not advance the arena by the whole
// time spent away.
window.addEventListener('focus', () => {
  lastFrameMs = performance.now()
})

window.addEventListener('resize', resize)
resize()
renderOverlay(overlay, session, { profile, durable: store.durable, beaten })
overlayPhase = session.phase
requestAnimationFrame(frame)
