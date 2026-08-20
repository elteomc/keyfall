# quick.md

## Summary

Keyfall is a browser typing game in a two-layer npm workspace.
`packages/typing-core` holds renderer-free typing intelligence (targeting,
metrics, digram statistics, combo, observations), and `apps/web` holds the
canvas game layer. The dependency runs one way only, and nothing in
`typing-core` may touch the DOM or the renderer.

Milestone 0 is closed. All seven milestone 1 items are built: five archetypes,
score, combo, a pressure curve, effects and audio, 5 to 10 minute runs, and a
result screen. Milestone 2 is built too: five of its six items fell out of
milestone 1, and local persistence has now been added.

A run now has an arc rather than only a failure. It follows the eight minute
shape in section 9 of the game design, and at 6:30 spawning stops and a closing
wave arrives. Clearing it ends the run as `cleared`, so a strong player finishes
a run instead of playing until they slip.

The result screen carries the six headline metrics from section 12 plus at most
three personalized observations: the slowest digram, accuracy under a crowded
arena, and rhythm across the two halves of the run. `typing-core` returns
structure and the overlay picks the wording, so a tentative finding cannot be
quietly promoted into a fact.

Runs are now kept between sessions. The profile holds aggregate skill
statistics, personal bests, corpus exposure and long-term digram timings in
IndexedDB, with raw events for the last three runs only. It can be exported,
imported and erased from the title screen.

## Status

Milestones 1 and 2 built, neither playtested. 138 tests pass,
`npm run typecheck` and `npm run build` are clean. Note for anyone running the
suite: the default vitest fork pool crashes in a sandboxed shell, and
`npx vitest run --pool=threads` runs the same suite fine.

Three exit criteria are now waiting on the same thing, a human playing the
game: milestone 0's "it is already satisfying to type", milestone 1's "friends
voluntarily replay", and milestone 2's "profile statistics are stable enough to
resemble observed typing behavior". None can be closed from here.

## Open questions

- **The game has never been played by a human.** Combo, scoring, the director
  and the run arc are all tuned by argument and by simulation. This is now the
  single largest source of risk in the project.
- Is the game too forgiving since the director started reading load? Under a
  simulated typist every speed now clears every run. That bot triages perfectly
  and pays no acquisition cost, so it cannot model what actually defeats a
  person. See D16.
- The closing wave is four to eight enemies with nothing following it, which a
  bot clears easily. Should the finale be heavier, or is it a victory lap?
- The combo hits its ceiling of 40 after roughly fifty clean words, so a strong
  player spends most of a run parked at the top. Raise the ceiling, or treat
  reaching it as arriving and leave it alone?
- Run length is section 21 question 8, to be settled by play. The arc currently
  lands at about 6 minutes 40.
- The IndexedDB path has never executed. vitest has no `indexedDB`, so the
  memory store carries the tested contract and every real operation is wrapped
  to degrade rather than throw. The first playtest is its first run.

## Repository layout

The repository publishes the game, not the process behind it. Source, tests,
package files, `README.md` and this file are tracked. The planning pack in
`docs/`, the long-form notes in `deep.md`, and the loop's per-run artifacts stay
on the machine they were written on.

This file is the one status document that ships, and the README points at it.

## Latest change

- Added local persistence, the one milestone 2 item that was not already built.
  `packages/typing-core/src/profile.ts` holds the pure fold, and
  `apps/web/src/game/storage.ts` holds the IndexedDB store with a memory
  fallback. Export, import and erase are on the title screen. Recorded as D18.
- Gave a run an ending: a stage arc in `apps/web/src/game/stages.ts`, a closing
  wave, and a `cleared` outcome. Recorded as D15.
- Fixed a difficulty cliff the arc exposed. Simulating full runs showed the
  director climbing for over two minutes against a pressure reading of 0.1, then
  the arena going from two enemies to eleven in twenty seconds. Arena occupancy
  is a lagging indicator. The director now also reads load, which is arrival
  rate against the player's own typing speed. Recorded as D16, which partly
  supersedes D10.
- Added `packages/typing-core/src/observations.ts` and put its findings on the
  result screen, hedged by sample size. Recorded as D17.
