import { describe, expect, test } from 'vitest'
import { type TypingEvent, emptyProfile, exportProfile, recordRun } from '@keyfall/typing-core'
import { RunSession } from '../src/game/session'
import { MAX_EVENT_RUNS, createMemoryStore, importInto } from '../src/game/storage'

/**
 * The store's contract, exercised through the memory implementation.
 *
 * IndexedDB itself is not available under vitest, which is exactly why the
 * interface is this small: everything worth asserting about pruning, import and
 * replacement is storage-agnostic and lives here.
 */

function event(key: string): TypingEvent {
  return {
    timestampMs: 0,
    key,
    code: key,
    runId: 'r',
    sequenceId: null,
    expectedChar: key,
    correct: true,
    charIndex: 0,
    previousCorrectKey: null,
    targetId: null,
    locked: false,
    pressure: 0,
  }
}

describe('profile store', () => {
  test('a fresh store hands back an empty profile', async () => {
    const store = createMemoryStore(0)
    expect((await store.load()).aggregate.runs).toBe(0)
    expect(store.durable).toBe(false)
  })

  test('a saved profile is handed back unchanged', async () => {
    const store = createMemoryStore(0)
    const profile = recordRun(
      emptyProfile(0),
      {
        record: {
          runId: 'run-1',
          startedAtMs: 0,
          durationMs: 1000,
          outcome: 'cleared',
          score: 42,
          kills: 3,
          wpm: 55,
          accuracy: 1,
          peakBurstWpm: 80,
          rhythm: null,
          acquisitionMs: null,
        },
        totalKeys: 10,
        correctKeys: 10,
        words: ['vector'],
        transitions: [],
      },
      1,
    )

    await store.save(profile)
    expect((await store.load()).bests.score).toBe(42)
  })

  test('raw events are pruned to the most recent runs', async () => {
    const store = createMemoryStore(0)

    for (let i = 0; i < MAX_EVENT_RUNS + 3; i++) {
      await store.saveEvents(`run-${i}`, [event('a')])
    }

    // Section 14 forbids an unbounded raw history in the browser.
    expect(await store.eventRuns()).toHaveLength(MAX_EVENT_RUNS)
    expect(await store.loadEvents('run-0')).toEqual([])
    expect(await store.loadEvents(`run-${MAX_EVENT_RUNS + 2}`)).toHaveLength(1)
  })

  test('import replaces the profile and drops the old raw events', async () => {
    const store = createMemoryStore(0)
    await store.saveEvents('old-run', [event('a')])

    const incoming = { ...emptyProfile(0), bests: { ...emptyProfile(0).bests, score: 777 } }
    const result = await importInto(store, exportProfile(incoming))

    expect(result?.bests.score).toBe(777)
    expect((await store.load()).bests.score).toBe(777)
    // Merging two histories would produce aggregates describing nobody.
    expect(await store.eventRuns()).toEqual([])
  })

  test('a bad import leaves the existing profile alone', async () => {
    const store = createMemoryStore(0)
    await store.save({ ...emptyProfile(0), bests: { ...emptyProfile(0).bests, score: 5 } })

    expect(await importInto(store, 'garbage')).toBeNull()
    expect((await store.load()).bests.score).toBe(5)
  })

  test('clear removes everything', async () => {
    const store = createMemoryStore(0)
    await store.save({ ...emptyProfile(0), bests: { ...emptyProfile(0).bests, score: 9 } })
    await store.saveEvents('run-1', [event('a')])

    await store.clear()

    expect((await store.load()).bests.score).toBe(0)
    expect(await store.eventRuns()).toEqual([])
  })
})

describe('session contribution', () => {
  test('there is nothing to record until a run has ended', () => {
    const session = new RunSession()
    session.start(0, 7)
    expect(session.contribution(1000)).toBeNull()
  })

  test('a finished run folds into a profile', () => {
    const session = new RunSession()
    session.start(0, 7)

    // Nobody types, so the run ends on breaches.
    let clock = 0
    while (session.phase === 'playing' && clock < 120_000) {
      clock += 16
      session.update(clock, 16)
    }

    const contribution = session.contribution(1_700_000_000_000)
    expect(contribution).not.toBeNull()
    expect(contribution!.record.outcome).toBe('breached')
    // Wall clock comes from the caller, since the session runs on a clock that
    // means nothing to a profile outliving the page.
    expect(contribution!.record.startedAtMs).toBe(1_700_000_000_000)
    expect(contribution!.words.length).toBeGreaterThan(0)

    const profile = recordRun(emptyProfile(0), contribution!, 1)
    expect(profile.aggregate.runs).toBe(1)
    expect(Object.keys(profile.corpusExposure).length).toBeGreaterThan(0)
  })
})
