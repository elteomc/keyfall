# quick.md

## Summary

Keyfall is a browser typing game in a two-layer npm workspace.
`packages/typing-core` holds renderer-free typing intelligence (targeting,
metrics, digram statistics, combo, observations, the profile fold, the skill
model and candidate selection), and `apps/web` holds the canvas game layer. The dependency runs one way only, and
nothing in `typing-core` may touch the DOM or the renderer.

Milestones 0, 1 and 2 are closed, exit criteria included. The game has now been
played by a human across two sessions, and the second one was reported as fun.
Persistence has been confirmed working in a real browser: the title screen
carries a run count, a best score and a typical wpm across reloads.

Milestone 3 is built and unplayed. The words a run serves are now chosen against
the player's own motor profile rather than drawn at random from a length band.

A run has an arc that advances on targets destroyed rather than on the clock.
Stage changes are announced and a hairline shows how far through the run the
player is. Reaching the finale ends the run as `cleared`, so a strong player
finishes a run instead of playing until they slip. The clock survives only as a
ten minute cap for a stalled run.

The result screen carries six headline metrics plus at most three personalized
observations: the slowest digram, accuracy under a crowded arena, and rhythm
across the two halves of the run. `typing-core` returns structure and the
overlay picks the wording, so a tentative finding cannot be quietly promoted
into a fact.

## Status

**Current milestone: 3, the adaptive director. Built, awaiting a playtest.**

198 tests pass across 16 files, `npm run typecheck` and `npm run build` are
clean. Note for anyone running the suite: the default vitest fork pool crashes
in a sandboxed shell, and `npx vitest run --pool=threads` runs the same suite
fine.

The game has zero runtime dependencies. `apps/web` depends on
`@keyfall/typing-core` and on nothing else, and `typing-core` depends on
nothing at all. Vite and vitest are the only build tooling.

### Milestones closed

- **0, mechanics sandbox.** Exit criterion was "it is already satisfying to
  type". Closed by playtest.
- **1, game prototype.** Five archetypes, score, combo, a pressure curve,
  effects and audio, runs of five to ten minutes, and a result screen. The exit
  criterion is "friends voluntarily replay". One player replays voluntarily.
  Nobody else has played it, so this is closed on the weaker evidence.
- **2, typing instrumentation.** Event telemetry, digram timing, errors,
  reaction time, rhythm and local persistence. The exit criterion is "profile
  statistics are stable enough to resemble observed typing behavior", and the
  profile now survives reloads and reports plausible lifetime figures.

### Milestone 3, built

All four items are in. `packages/typing-core/src/skill.ts` prices any word for
one player by pulling each digram toward the average for its movement class and
that class toward the player's own average, so it can estimate a transition the
player has never typed (D24). `selection.ts` sorts a length band into comfort,
frontier, weakness and exploration (D25) and samples inside one with diversity
penalties (D27). `apps/web/src/game/selector.ts` picks the bucket from arena
pressure and holds the caps and hysteresis (D26).

The idea the milestone turns on: **a weakness is where a player is worse than
their own profile predicts, not where they are slow in milliseconds.**
Same-finger pairs are slow for everybody, so an absolute ranking hands every
player the same list and no two runs would differ.

Its exit criterion is that two typists with different weaknesses receive visibly
different challenge distributions without obvious repetitive drilling. The
arithmetic half is now a test: two synthetic typists diverge at a total
variation distance of 0.43 against a 0.11 noise floor for the same typist on a
different seed, while concentration stays level with a control that has nothing
to target. Whether it *feels* smart rather than manipulative is section 21
question 9 and needs a person.

## Open questions

- **Milestone 3 has never been played.** Everything about it is tuned by
  argument and by measurement against synthetic typists.
- A run's adaptation is only as good as the profile behind it, and the profile
  on this machine is two runs old. The first genuinely adapted run is some way
  off.
- The clock cap bounds when the finale starts, not when the run ends, so a
  slower run finishes a few seconds past ten minutes. Small, and recorded in
  `apps/web/test/stages.test.ts` rather than asserted away.
- `seededBaseline` on the combo tracker is still unwired. The profile knows the
  player's typical speed and the combo re-learns it from scratch every run. It
  was left alone deliberately, to avoid adding a third unattributed variable to
  the difficulty question below.
- Two tuning changes shipped together, so neither can be attributed yet. The
  `hot` tier shield makes the player harder to kill, and the load signal drives
  arrivals much closer to the player's measured speed. A report of "too easy"
  or "too hard" currently has two possible causes. See D20 and D16. Deferred by
  the user rather than answered.
- The combo reaches its ceiling of 40 after roughly fifty clean words, so a
  strong player spends most of a run parked at the top with nothing left to
  climb. Raise the ceiling, or treat arriving as the reward?
- Is the finale a real test or a victory lap? It is a wave of five to ten with
  nothing behind it.
- Run length is section 21 question 8, to be settled by play. The arc currently
  lands near five minutes for a fast player and six and a half for an average
  one.
- Simulation cannot answer whether the game is hard enough. The bot triages
  perfectly and pays no target acquisition cost, so every simulated speed
  clears every run. Only play settles difficulty.

## Repository layout

The repository publishes the game, not the process behind it. Source, tests,
package files, `README.md` and this file are tracked. The planning pack in
`docs/`, the long-form notes in `deep.md`, and the loop's per-run artifacts stay
on the machine they were written on.

This file is the one status document that ships, and the README points at it.

## Latest change

- Built milestone 3, the adaptive director. A per-player skill model, four
  candidate buckets, a bucket mix that follows arena pressure, and caps against
  drilling. Recorded as D24 through D29.
- Two findings from measuring it, both of which looked correct in the code.
  Bucketing every word containing a weak pair as weakness put three quarters of
  the corpus behind the anti-drill cap and made a player weak at `on` meet it
  *less* than a player who was fine at it, 21 percent against 78. And scoring
  candidates by fit alone served an eighty word band as sixty-two distinct
  words, which is the first playtest's repetition complaint arriving by a
  subtler route.
- Fixed the way a wrong key is handled, twice. The cursor now never advances on
  a wrong key, so a word can only ever be finished by typing it. One slip is
  charged once, and the keys already in flight behind it pass silently.
  Immediately after a slip the word accepts either the character it still wants
  or the one after it, which covers both noticing and not noticing. Recorded as
  D21.
- Made the combo do something other than multiply score. `hot` arms a shield
  that absorbs one breach, and `peak` draws words from a longer band. The rule
  behind it is that a reward gives you more of the core verb, not less of it.
  Recorded as D20.
- Put the run arc on progress rather than the clock, and made it visible.
  Recorded as D22, superseding D15.
- Fixed a targeting bug that read correctly typed words as wrong. Enemies were
  drawn before they were targetable, so a visible word could be excluded from
  the candidate set and a prefix would lock the wrong target. Every enemy in
  the arena is now a candidate. Recorded as D19, superseding D3.
- Added a stop key. `Esc` pauses, and `Q` from there stops the run and returns
  to the title. A stopped run is not recorded. Recorded as D23.
- Fixed effective wpm, which reported the spawn rate rather than the player.
  It is now measured over time spent inside words rather than over elapsed run
  time.
- Grew the corpus from 82 words to 420, because a six minute run destroys
  several hundred words and a small pool repeats inside a single run.
