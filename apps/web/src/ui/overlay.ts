import type { Observation } from '@keyfall/typing-core'

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

function percent(value: number | undefined): string {
  return `${((value ?? 0) * 100).toFixed(0)}%`
}

/**
 * Turns one observation into a sentence.
 *
 * Section 12 of the product spec asks for hedged wording until the sample
 * supports more, so the verb is chosen from `confidence` and from nothing else.
 * The analysis in `typing-core` decides how sure it is, and this decides how
 * that sounds. Keeping those apart is what stops the copy from quietly
 * promoting a tentative finding into a fact.
 */
function observationText(o: Observation): string {
  const sure = o.confidence === 'settled'

  switch (o.kind) {
    case 'slowest-transition': {
      const many = o.digrams.length > 1
      const names = o.digrams.map((d) => `<code>${d}</code>`).join(' and ')
      const ms = Math.round(Math.max(...o.values, 0))
      return sure
        ? `${names} ${many ? 'were' : 'was'} your slowest ${many ? 'transitions' : 'transition'} this run, around ${ms} ms.`
        : `${names} ${many ? 'seem' : 'seems'} to be among your slower transitions so far, around ${ms} ms.`
    }

    case 'accuracy-under-pressure': {
      const calm = percent(o.values[0])
      const pressed = percent(o.values[1])
      if (o.direction === 'worse') {
        return sure
          ? `Your accuracy dropped when the arena was crowded, ${pressed} against ${calm}.`
          : `Your accuracy seemed to slip when the arena was crowded, ${pressed} against ${calm}.`
      }
      if (o.direction === 'better') {
        return sure
          ? `You held accuracy under a crowded arena, ${pressed} against ${calm}.`
          : `You seemed to hold accuracy under a crowded arena, ${pressed} against ${calm}.`
      }
      return `A crowded arena cost you a little accuracy, ${pressed} against ${calm}.`
    }

    case 'rhythm-drift': {
      if (o.direction === 'better') {
        return sure
          ? 'Your rhythm was steadier in the second half than the first.'
          : 'Your rhythm seemed steadier in the second half than the first.'
      }
      if (o.direction === 'worse') {
        return sure
          ? 'Your rhythm was less even by the end of the run.'
          : 'Your rhythm seemed less even by the end of the run.'
      }
      return 'Your rhythm held steady from start to finish.'
    }
  }
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

  const verdict =
    summary.outcome === 'cleared'
      ? `Run cleared in ${clock}. You held the final wave, ${summary.kills} targets down.`
      : `${summary.kills} targets down in ${clock}.`

  const observations =
    summary.observations.length === 0
      ? ''
      : `<h2>What this run suggests</h2>
      <ul class="observations">${summary.observations.map((o) => `<li>${observationText(o)}</li>`).join('')}</ul>`

  return `
    <section class="card">
      <h1>${summary.score}</h1>
      <p class="lede">${verdict}</p>
      <dl class="stats">
        <div><dt>effective wpm</dt><dd>${summary.wpm.toFixed(0)}</dd></div>
        <div><dt>accuracy</dt><dd>${(summary.accuracy * 100).toFixed(1)}%</dd></div>
        <div><dt>peak burst</dt><dd>${summary.peakBurstWpm.toFixed(0)}</dd></div>
        <div><dt>rhythm</dt><dd>${rhythm}</dd></div>
        <div><dt>target acquisition</dt><dd>${acquisition}</dd></div>
      </dl>
      ${observations}
      <h2>Slowest well sampled transitions</h2>
      <ul class="transitions">${slowest}</ul>
      <p class="prompt">Press <kbd>Enter</kbd> to run again</p>
    </section>
  `
}
