import { type Observation, type PersonalBests, type Profile, lifetimeAccuracy } from '@keyfall/typing-core'

import type { SelectorReport } from '../game/selector'
import type { RunSession, RunSummary } from '../game/session'

/** Everything the overlay needs that does not live on the session. */
export interface OverlayContext {
  profile: Profile
  /** False when storage is unavailable, so nothing may promise a history. */
  durable: boolean
  /** Personal bests this run beat, read before the run was folded in. */
  beaten: readonly string[]
}

/**
 * Title and post-run screens.
 *
 * Restart has to be effectively instant, so there is no menu here. One key
 * starts the next run.
 */
export function renderOverlay(
  root: HTMLElement,
  session: RunSession,
  context: OverlayContext,
): void {
  if (session.phase === 'playing') {
    root.innerHTML = ''
    root.dataset.visible = 'false'
    return
  }

  root.dataset.visible = 'true'
  root.innerHTML =
    session.phase === 'title'
      ? titleCard(context)
      : session.phase === 'paused'
        ? pausedCard()
        : summaryCard(session.currentSummary(), context)
}

function titleCard(context: OverlayContext): string {
  return `
    <section class="card">
      <h1>Keyfall</h1>
      <p class="lede">Type the word to lock the target. Keep typing to destroy it.</p>
      <ul class="hints">
        <li>A shared first letter locks nothing. Type until the prefix is unique.</li>
        <li>A slip costs accuracy and combo, not the word. Keep going.</li>
        <li>Shielded words are the exception. One slip and the word starts over.</li>
        <li>A hot streak absorbs one breach. A peak streak brings richer words.</li>
        <li><kbd>Esc</kbd> pauses. From there, <kbd>Q</kbd> stops the run.</li>
        <li>Three breaches end the run.</li>
        <li><kbd>Ctrl</kbd>+<kbd>M</kbd> turns the sound off and on.</li>
      </ul>
      <p class="prompt">Press <kbd>Enter</kbd> to start</p>
      ${historyLine(context)}
      <p class="note">
        Keystrokes are recorded only while a run is active, and only in this browser.
        <kbd>Ctrl</kbd>+<kbd>E</kbd> exports your profile,
        <kbd>Ctrl</kbd>+<kbd>O</kbd> imports one,
        <kbd>Ctrl</kbd>+<kbd>Delete</kbd> erases everything.
      </p>
    </section>
  `
}

/**
 * What the profile knows so far.
 *
 * Says nothing at all before the first run has been recorded, because an
 * opening screen full of zeroes tells a new player only that they are new.
 */
function historyLine(context: OverlayContext): string {
  const { runs, typicalWpm } = context.profile.aggregate
  if (runs === 0) return ''

  const plural = runs === 1 ? 'run' : 'runs'
  const held = context.durable
    ? ''
    : ' <strong>Storage is unavailable, so this run will not be kept.</strong>'

  return `<p class="history">${runs} ${plural} recorded. Best ${context.profile.bests.score}, usually around ${typicalWpm.toFixed(0)} wpm at ${(lifetimeAccuracy(context.profile) * 100).toFixed(0)}% accuracy.${held}</p>`
}

const BEST_LABELS: Record<keyof PersonalBests, string> = {
  score: 'best score',
  wpm: 'best wpm',
  accuracy: 'best accuracy',
  kills: 'most targets',
  longestRunMs: 'longest run',
}

/** Records this run beat, named rather than merely counted. */
function beatenLine(context: OverlayContext): string {
  if (context.beaten.length === 0) return ''

  const names = context.beaten
    .map((key) => BEST_LABELS[key as keyof PersonalBests] ?? key)
    .join(', ')
  return `<p class="beaten">New ${names}.</p>`
}

function pausedCard(): string {
  return `
    <section class="card">
      <h1>Paused</h1>
      <p class="lede">Nothing is falling and the clock is stopped.</p>
      <p class="prompt">Press <kbd>Esc</kbd> or <kbd>Enter</kbd> to carry on</p>
      <p class="note">
        Your target was released, which costs nothing.
        Press <kbd>Q</kbd> to stop and return to the title. A run you stop is
        not recorded.
      </p>
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

/**
 * What the run chose to put in front of the player, in one or two sentences.
 *
 * Milestone 3's exit criterion asks for challenge distributions that are
 * *visibly* different between players, and a distribution nobody can see is
 * only half of that. It also answers the question a player will otherwise ask
 * first, which is whether the game is doing anything at all.
 *
 * It says nothing when the run drew no weakness words, rather than reporting a
 * zero. A run where the arena stayed busy is a run that never had a calm moment
 * to teach in, which is the policy working rather than a result worth printing.
 */
function trainingLine(selection: SelectorReport): string {
  if (!selection.adapting) {
    return `<p class="training">Still learning how you type. Once enough of a profile has built up, the words a run picks will start answering it.</p>`
  }

  const trained = selection.trained.slice(0, 3)
  if (trained.length === 0 || selection.counts.weakness === 0) return ''

  const names = trained.map((t) => `<code>${t.digram.replace(' ', '')}</code>`).join(' and ')
  const plural = selection.counts.weakness === 1 ? 'target was' : 'targets were'
  return `<p class="training">${selection.counts.weakness} ${plural} chosen to put ${names} in front of you. Those are transitions where you are slower than the rest of your typing predicts.</p>`
}

function summaryCard(summary: RunSummary | null, context: OverlayContext): string {
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
      ${beatenLine(context)}
      <dl class="stats">
        <div><dt>effective wpm</dt><dd>${summary.wpm.toFixed(0)}</dd></div>
        <div><dt>accuracy</dt><dd>${(summary.accuracy * 100).toFixed(1)}%</dd></div>
        <div><dt>peak burst</dt><dd>${summary.peakBurstWpm.toFixed(0)}</dd></div>
        <div><dt>rhythm</dt><dd>${rhythm}</dd></div>
        <div><dt>target acquisition</dt><dd>${acquisition}</dd></div>
      </dl>
      ${observations}
      ${trainingLine(summary.selection)}
      <h2>Slowest well sampled transitions</h2>
      <ul class="transitions">${slowest}</ul>
      <p class="prompt">Press <kbd>Enter</kbd> to run again</p>
      ${historyLine(context)}
    </section>
  `
}
