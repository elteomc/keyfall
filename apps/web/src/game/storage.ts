import {
  type Profile,
  type TypingEvent,
  emptyProfile,
  importProfile,
  isProfile,
} from '@keyfall/typing-core'

/**
 * Where the profile lives between sessions.
 *
 * Section 2 of the technical plan is specific: IndexedDB for local history and
 * the profile, `localStorage` only for lightweight settings. So the profile and
 * the raw event history are here, and the audio mute stays where it is.
 *
 * Section 14 says the browser must not accumulate raw events forever. Events
 * therefore live in their own object store keyed by run, pruned to the last few
 * runs, which keeps the profile record itself small enough to read on every
 * start. Aggregates last forever, raw events do not.
 *
 * Every call degrades to memory rather than throwing. A player in a private
 * window with storage blocked should still get a game, just not a history, and
 * a failed write must never cost them the run they just finished.
 */

const DB_NAME = 'keyfall'
const DB_VERSION = 1
const PROFILE_STORE = 'profile'
const EVENT_STORE = 'events'
const PROFILE_KEY = 'local'

/** Runs whose raw events are kept. Older runs survive only as aggregates. */
export const MAX_EVENT_RUNS = 3

export interface ProfileStore {
  load(): Promise<Profile>
  save(profile: Profile): Promise<void>
  saveEvents(runId: string, events: readonly TypingEvent[]): Promise<void>
  loadEvents(runId: string): Promise<TypingEvent[]>
  /** Run ids that still have raw events, newest last. */
  eventRuns(): Promise<string[]>
  clear(): Promise<void>
  /** False when the profile is being held in memory and will not survive a reload. */
  readonly durable: boolean
}

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      return resolve(null)
    }

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(PROFILE_STORE)) db.createObjectStore(PROFILE_STORE)
      if (!db.objectStoreNames.contains(EVENT_STORE)) db.createObjectStore(EVENT_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    // Another tab holding an old version open would otherwise hang forever.
    request.onblocked = () => resolve(null)
  })
}

function request<T>(operation: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    operation.onsuccess = () => resolve(operation.result)
    operation.onerror = () => resolve(null)
  })
}

/**
 * A store that forgets everything on reload.
 *
 * Used when IndexedDB is unavailable, and directly by tests, which is the point
 * of keeping the interface this small.
 */
export function createMemoryStore(nowMs = 0): ProfileStore {
  let profile = emptyProfile(nowMs)
  const events = new Map<string, TypingEvent[]>()
  const order: string[] = []

  return {
    durable: false,
    async load() {
      return profile
    },
    async save(next) {
      profile = next
    },
    async saveEvents(runId, list) {
      events.set(runId, [...list])
      order.push(runId)
      while (order.length > MAX_EVENT_RUNS) {
        const oldest = order.shift()
        if (oldest !== undefined) events.delete(oldest)
      }
    },
    async loadEvents(runId) {
      return events.get(runId) ?? []
    },
    async eventRuns() {
      return [...order]
    },
    async clear() {
      profile = emptyProfile(nowMs)
      events.clear()
      order.length = 0
    },
  }
}

/**
 * Runs a storage operation, falling back rather than throwing.
 *
 * A connection can be closed under us at any time, by a version change in
 * another tab or by the browser reclaiming storage. None of that is worth
 * losing a run over, and an unhandled rejection from the frame loop would be
 * far worse than a missing history entry.
 */
async function guard<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation()
  } catch {
    return fallback
  }
}

export async function createProfileStore(nowMs: number): Promise<ProfileStore> {
  const db = await openDatabase()
  if (db === null) return createMemoryStore(nowMs)

  const store = (name: string, mode: IDBTransactionMode): IDBObjectStore =>
    db.transaction(name, mode).objectStore(name)

  const listEventRuns = (): Promise<string[]> =>
    guard(async () => {
      const keys = await request(store(EVENT_STORE, 'readonly').getAllKeys())
      return Array.isArray(keys) ? keys.map(String) : []
    }, [])

  return {
    durable: true,

    load: () =>
      guard(async () => {
        const raw = await request(store(PROFILE_STORE, 'readonly').get(PROFILE_KEY))
        // A record written by an older version, or a half-written one, is
        // replaced rather than repaired. See `importProfile`.
        return isProfile(raw) ? raw : emptyProfile(nowMs)
      }, emptyProfile(nowMs)),

    save: (profile) =>
      guard(async () => {
        await request(store(PROFILE_STORE, 'readwrite').put(profile, PROFILE_KEY))
      }, undefined),

    saveEvents: (runId, events) =>
      guard(async () => {
        await request(store(EVENT_STORE, 'readwrite').put([...events], runId))

        // Run ids do not sort into arrival order, so the prune asks the store
        // what it holds rather than assuming one.
        const keys = await listEventRuns()
        const stale = keys.slice(0, Math.max(0, keys.length - MAX_EVENT_RUNS))
        for (const key of stale) {
          await request(store(EVENT_STORE, 'readwrite').delete(key))
        }
      }, undefined),

    loadEvents: (runId) =>
      guard(async () => {
        const raw = await request(store(EVENT_STORE, 'readonly').get(runId))
        return Array.isArray(raw) ? (raw as TypingEvent[]) : []
      }, []),

    eventRuns: listEventRuns,

    clear: () =>
      guard(async () => {
        await request(store(PROFILE_STORE, 'readwrite').clear())
        await request(store(EVENT_STORE, 'readwrite').clear())
      }, undefined),
  }
}

/**
 * Reads an exported profile back in.
 *
 * Import replaces rather than merges. Merging two histories would produce
 * aggregate statistics that describe nobody, and the player cannot inspect the
 * result to notice.
 */
export async function importInto(store: ProfileStore, json: string): Promise<Profile | null> {
  const profile = importProfile(json)
  if (profile === null) return null
  await store.clear()
  await store.save(profile)
  return profile
}
