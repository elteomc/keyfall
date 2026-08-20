import { describe, expect, test } from 'vitest'
import {
  type Observation,
  type ObservationKind,
  type TransitionStat,
  type TypingEvent,
  deriveObservations,
} from '../src/index'

function stat(from: string, to: string, shrunkMeanMs: number, samples = 20): TransitionStat {
  return { from, to, meanMs: shrunkMeanMs, shrunkMeanMs, samples, errors: 0, errorRate: 0 }
}

/** `n` keystrokes at a given pressure, of which `correct` were right. */
function keys(n: number, correct: number, pressure: number): TypingEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    timestampMs: i * 100,
    key: 'a',
    code: 'a',
    runId: 'test',
    sequenceId: 'word',
    expectedChar: 'a',
    correct: i < correct,
    charIndex: 0,
    previousCorrectKey: null,
    targetId: 't',
    locked: true,
    pressure,
  }))
}

function find(observations: Observation[], kind: ObservationKind): Observation | undefined {
  return observations.find((o) => o.kind === kind)
}

const NOTHING = { events: [], slowest: [], rhythmSamples: [] }

describe('deriveObservations', () => {
  test('says nothing when there is nothing to say', () => {
    expect(deriveObservations(NOTHING)).toEqual([])
  })

  test('never returns more than the spec allows', () => {
    const result = deriveObservations({
      events: [...keys(200, 198, 0.1), ...keys(200, 196, 0.9)],
      slowest: [stat('p', 'h', 190), stat('r', 'l', 120)],
      rhythmSamples: Array.from({ length: 40 }, (_, i) => (i < 20 ? 0.5 : 0.9)),
    })

    // Section 12 asks for at most two or three.
    expect(result.length).toBeLessThanOrEqual(3)
  })

  describe('slowest transition', () => {
    test('names a companion only when it is nearly as slow', () => {
      const paired = find(
        deriveObservations({ ...NOTHING, slowest: [stat('p', 'h', 200), stat('r', 'l', 190)] }),
        'slowest-transition',
      )
      expect(paired?.digrams).toEqual(['ph', 'rl'])

      const alone = find(
        deriveObservations({ ...NOTHING, slowest: [stat('p', 'h', 200), stat('r', 'l', 90)] }),
        'slowest-transition',
      )
      expect(alone?.digrams).toEqual(['ph'])
    })

    test('a thin sample stays tentative', () => {
      const thin = find(
        deriveObservations({ ...NOTHING, slowest: [stat('p', 'h', 200, 5)] }),
        'slowest-transition',
      )
      expect(thin?.confidence).toBe('tentative')

      const thick = find(
        deriveObservations({ ...NOTHING, slowest: [stat('p', 'h', 200, 60)] }),
        'slowest-transition',
      )
      expect(thick?.confidence).toBe('settled')
    })
  })

  describe('accuracy under pressure', () => {
    test('stays silent until both buckets are worth comparing', () => {
      const result = deriveObservations({
        ...NOTHING,
        events: [...keys(200, 200, 0.1), ...keys(5, 1, 0.9)],
      })
      expect(find(result, 'accuracy-under-pressure')).toBeUndefined()
    })

    test('reads a real drop as worse and a held line as better', () => {
      const dropped = find(
        deriveObservations({ ...NOTHING, events: [...keys(100, 98, 0.1), ...keys(100, 80, 0.9)] }),
        'accuracy-under-pressure',
      )
      expect(dropped?.direction).toBe('worse')

      const held = find(
        deriveObservations({ ...NOTHING, events: [...keys(100, 98, 0.1), ...keys(100, 98, 0.9)] }),
        'accuracy-under-pressure',
      )
      expect(held?.direction).toBe('better')
    })

    test('a reflex space is not charged as a wrong key', () => {
      const spaces: TypingEvent[] = keys(40, 0, 0.9).map((e) => ({
        ...e,
        key: ' ',
        code: 'Space',
        expectedChar: null,
      }))

      const result = find(
        deriveObservations({
          ...NOTHING,
          events: [...keys(100, 100, 0.1), ...keys(100, 100, 0.9), ...spaces],
        }),
        'accuracy-under-pressure',
      )

      // Every real key was correct, so both buckets must read as perfect. See D2.
      expect(result?.values).toEqual([1, 1])
    })
  })

  describe('rhythm drift', () => {
    test('needs enough words in both halves', () => {
      const result = deriveObservations({ ...NOTHING, rhythmSamples: [0.5, 0.6, 0.7] })
      expect(find(result, 'rhythm-drift')).toBeUndefined()
    })

    test('compares the two halves and ignores an odd middle word', () => {
      // Nine samples: four low, one pivot, four high. The middle belongs to
      // neither half, so a single word cannot tilt the comparison.
      const result = find(
        deriveObservations({
          ...NOTHING,
          rhythmSamples: [0.4, 0.4, 0.4, 0.4, 0.0, 0.9, 0.9, 0.9, 0.9],
        }),
        'rhythm-drift',
      )

      expect(result?.direction).toBe('better')
      expect(result?.values).toEqual([0.4, 0.9])
    })

    test('a flat run reads as steady rather than as a trend', () => {
      const result = find(
        deriveObservations({ ...NOTHING, rhythmSamples: [0.7, 0.71, 0.69, 0.7, 0.7, 0.71, 0.7, 0.7] }),
        'rhythm-drift',
      )
      expect(result?.direction).toBe('steady')
    })
  })
})
