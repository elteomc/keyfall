import './style.css'
import { render } from './game/render'
import { RunSession } from './game/session'
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
let lastFrameMs = performance.now()
let overlayPhase: string | null = null

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

  if (!document.hidden) session.update(nowMs, dtMs)
  render(ctx, session, canvas.width, canvas.height, nowMs)

  if (session.phase !== overlayPhase) {
    overlayPhase = session.phase
    renderOverlay(overlay, session)
  }

  requestAnimationFrame(frame)
}

function isTypingKey(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey
}

window.addEventListener('keydown', (event) => {
  const nowMs = performance.now()

  if (session.phase !== 'playing') {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      lastFrameMs = nowMs
      session.start(nowMs)
      renderOverlay(overlay, session)
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
renderOverlay(overlay, session)
overlayPhase = session.phase
requestAnimationFrame(frame)
