/**
 * Normalized keystroke telemetry.
 *
 * Every gameplay-relevant key event becomes one record. Completed-word
 * summaries are never enough on their own: the raw stream is the signal that
 * later feeds the skill model.
 */
export interface TypingEvent {
  timestampMs: number
  key: string
  code: string

  runId: string
  sequenceId: string | null

  expectedChar: string | null
  correct: boolean

  charIndex: number | null
  previousCorrectKey: string | null

  targetId: string | null
  locked: boolean

  /** Coarse game pressure at the moment of the keystroke, in [0, 1]. */
  pressure: number

  correction?: boolean
}

export interface EventRecorder {
  readonly runId: string
  record(event: Omit<TypingEvent, 'runId'>): TypingEvent
  events(): readonly TypingEvent[]
  count(): number
  clear(): void
}

/**
 * Collects events for a single run.
 *
 * The buffer is capped because a long run can produce tens of thousands of
 * events and the browser has better things to do with that memory. Aggregates
 * are computed as we go, so dropping the oldest raw events is safe.
 */
export function createRecorder(runId: string, maxEvents = 20000): EventRecorder {
  const buffer: TypingEvent[] = []

  return {
    runId,
    record(event) {
      const full: TypingEvent = { ...event, runId }
      buffer.push(full)
      if (buffer.length > maxEvents) buffer.shift()
      return full
    },
    events() {
      return buffer
    },
    count() {
      return buffer.length
    },
    clear() {
      buffer.length = 0
    },
  }
}
