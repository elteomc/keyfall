import type { RunSession, RunSummary } from '../game/session'

/**
 * Title and post-run screens.
 *
 * Restart has to be effectively instant, so there is no menu here. One key
 * starts the next run.
 */
export function renderOverlay(root: HTMLElement, session: RunSession): void {
  if (session.phase === 'playing') {
    root.innerHTML = ''
    root.dataset.visible = 'false'
    return
  }

  root.dataset.visible = 'true'
  root.innerHTML = session.phase === 'title' ? titleCard() : summaryCard(session.currentSummary())
}

function titleCard(): string {
  return `
    <section class="card">
      <h1>Keyfall</h1>
      <p class="lede">Type the word to lock the target. Keep typing to destroy it.</p>
      <ul class="hints">
        <li>A shared first letter locks nothing. Type until the prefix is unique.</li>
        <li>A wrong key keeps the lock. It costs accuracy, not your target.</li>
        <li>Shielded words are the exception. One slip and the word starts over.</li>
        <li>Escape releases the current target.</li>
        <li>Three breaches end the run.</li>
        <li><kbd>Ctrl</kbd>+<kbd>M</kbd> turns the sound off and on.</li>
      </ul>
      <p class="prompt">Press <kbd>Enter</kbd> to start</p>
      <p class="note">Keystrokes are recorded only while a run is active, and only in this browser.</p>
    </section>
  `
}

function summaryCard(summary: RunSummary | null): string {
  if (!summary) return '<section class="card"><h1>Run over</h1></section>'

  const seconds = summary.timeMs / 1000
  const clock = `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
  const rhythm = summary.rhythm === null ? 'not enough data' : summary.rhythm.toFixed(2)
  const acquisition =
    summary.acquisitionMs === null ? 'not enough data' : `${summary.acquisitionMs.toFixed(0)} ms`

  const slowest =
    summary.slowest.length === 0
      ? '<li class="empty">Not enough samples yet for transition timings.</li>'
      : summary.slowest
          .map(
            (s) =>
              `<li><code>${s.from}${s.to}</code><span>${s.shrunkMeanMs.toFixed(0)} ms</span><small>${s.samples} samples</small></li>`,
          )
          .join('')

  return `
    <section class="card">
      <h1>${summary.score}</h1>
      <p class="lede">${summary.kills} targets down in ${clock}</p>
      <dl class="stats">
        <div><dt>effective wpm</dt><dd>${summary.wpm.toFixed(0)}</dd></div>
        <div><dt>accuracy</dt><dd>${(summary.accuracy * 100).toFixed(1)}%</dd></div>
        <div><dt>peak burst</dt><dd>${summary.peakBurstWpm.toFixed(0)}</dd></div>
        <div><dt>rhythm</dt><dd>${rhythm}</dd></div>
        <div><dt>target acquisition</dt><dd>${acquisition}</dd></div>
      </dl>
      <h2>Slowest well sampled transitions</h2>
      <ul class="transitions">${slowest}</ul>
      <p class="prompt">Press <kbd>Enter</kbd> to run again</p>
    </section>
  `
}
