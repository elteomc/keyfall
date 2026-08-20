# quick.md

## Summary

Keyfall is a browser typing game in a two-layer npm workspace.
`packages/typing-core` holds renderer-free typing intelligence (targeting,
metrics, digram statistics, combo), and `apps/web` holds the canvas game layer.
The dependency runs one way only, and nothing in `typing-core` may touch the
DOM or the renderer.

Milestone 0 is closed. Milestone 1 asks for archetypes, score, combo, a
pressure curve, effects and audio, 5 to 10 minute runs, and a result screen.

Delivered in milestone 1 so far:

- Five archetypes: drone, swarm, tank, sprinter, and shield, where one wrong
  key sends the word back to the start.
- The combo system, with a speed baseline measured against the player's own
  pace and four sticky tiers shown as colour rather than as a number.
- A difficulty director that runs spawn interval, fall speed and archetype
  weights off one dial, with a deadband, a lag, and a capped rate.
- Run scoring, where every multiplier is bounded so that typing well beats
  chasing the fanciest archetype by arithmetic rather than by intention.
- Audio and hit feedback, a Web Audio synth with no new dependency, plus
  sparks, rings and shake that thicken with the combo tier.

Still open in milestone 1: a run that can end somewhere other than a breach,
and personalized observations on the result screen.

## Open questions

- The combo hits its ceiling of 40 after roughly fifty clean words, so a strong
  player spends most of a run parked at the top. Raise the ceiling, or treat
  reaching it as arriving and leave it alone?
- Milestone 1 wants 5 to 10 minute runs, and a run currently ends only on three
  breaches, so a strong player never stops. Timed ending, boss, or a split
  between run and endless?
- Which two or three observations belong on the result screen, given that
  `01-product-spec.md` section 12 asks for at most three and warns against
  claiming statistical certainty too early?
- The game has still never been played by a human. Combo, director and scoring
  are all tuned by argument rather than by feel.

## Status

Milestone 1, five of seven items delivered. 96 tests pass, `npm run typecheck`
and `npm run build` are clean. Note for anyone running the suite: the default
vitest fork pool crashes in a sandboxed shell, and `npx vitest run
--pool=threads` runs the same suite fine.

## Repository layout

The repository publishes the game, not the process behind it. Source, tests,
package files, `README.md` and this file are tracked. The planning pack in
`docs/`, the long-form notes in `deep.md`, `AGENTS.md`, and the loop's per-run
artifacts stay on the machine they were written on.

This file is the one status document that ships, and the README points at it.

## Latest change

- Restored the tracking rules after a history rewrite had removed this file
  from the repository along with the planning notes. Republished the project
  from a clean history that never carried the notes at all.
