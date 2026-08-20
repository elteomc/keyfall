# Keyfall

A typing game where typing is the controller and typing skill is treated as a
learnable motor profile.

## Play the current build

```sh
npm install
npm run dev
```

Then open the printed URL and press Enter. The current build is a prototype:
five enemy archetypes, prefix targeting, a combo, and a difficulty director.
See [quick.md](quick.md) for what exists and what does not.

## Working concept

A typing game that treats **typing as a real-time game mechanic** and **typing skill as a learnable motor profile**, rather than reducing the player to one WPM number.

The v1 goal is:

> **Make typing practice as intrinsically fun as ZType, while making the training substantially smarter than conventional typing tests.**

This planning pack intentionally does **not** make AI-generated text, coding workflows, Vim, shell navigation, or whole-computer operation part of the first release. Those are strong follow-up directions, but v1 should first prove that the core loop is fun and that adaptive training creates a noticeable improvement.

## Product principles

1. **The game must be fun even if the player does not care about typing improvement.**
2. **Typing is the controller.** Avoid bolting typing onto a game whose real mechanics happen elsewhere.
3. **Accuracy comes before reckless speed.**
4. **Smoothness matters.** Rhythm and hesitation are first-class signals.
5. **Personalization should emerge from measured behavior, not questionnaires.**
6. **Useful typing beats dictionary trivia.** Training material should resemble real language and real key transitions.
7. **The player should feel adaptation, but not feel punished by it.**
8. **Metrics should inform play, not dominate it.**
9. **No AI dependency for v1.** The game should work fully offline or with deterministic content generation.
10. **Architect for richer domains later**: prose, programming, LaTeX/Typst, terminal usage, Vim/editor operations.

## What success looks like for the first public alpha

A player should be able to open the game, play immediately, and within 10 to 15 minutes experience all of the following:

- typing directly controls targeting and attacks,
- several enemy archetypes require meaningfully different typing behavior,
- the game visibly reacts to their strengths and weaknesses,
- rhythm/smoothness matters in addition to WPM,
- failure feels like a game failure rather than a typing-test failure,
- after a run, they can understand one or two concrete things about how they type,
- they want to play another run.

That last point matters more than almost every dashboard metric.
