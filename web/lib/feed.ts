/** The latest value of something read periodically, and how fresh it is. */
export interface FeedState<T> {
  data: T | null
  /** The last read failed. `data` still holds the last good value, if any. */
  error: unknown
  loading: boolean
  /** When `data` was read, unix milliseconds. */
  updatedAt: number | null
}

export interface FeedOptions {
  /** How often to read while someone is watching and the page is visible. */
  intervalMs: number
  now?: () => number
}

/**
 * Reads a value on a timer while anyone is subscribed, and right away on request. Readers that overlap are
 * folded into one, and a slow answer never replaces a newer one.
 */
export class Feed<T> {
  private readonly load: () => Promise<T>
  private readonly options: Required<FeedOptions>
  private readonly listeners = new Set<() => void>()
  private state: FeedState<T> = { data: null, error: null, loading: false, updatedAt: null }
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight: Promise<void> | null = null
  private generation = 0

  constructor(load: () => Promise<T>, options: FeedOptions) {
    this.load = load
    this.options = { now: Date.now, ...options }
  }

  getState = (): FeedState<T> => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) this.start()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stop()
    }
  }

  /** Reads now. Resolves once the read has finished, whether it succeeded or not. */
  refresh(): Promise<void> {
    this.inFlight ??= this.read().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /** Forgets the value, so nothing of a previous account is shown for the next one. */
  clear(): void {
    this.generation++
    this.set({ data: null, error: null, loading: false, updatedAt: null })
  }

  private async read(): Promise<void> {
    const generation = this.generation
    this.set({ ...this.state, loading: true })
    try {
      const data = await this.load()
      if (generation === this.generation) this.set({ data, error: null, loading: false, updatedAt: this.options.now() })
    } catch (error) {
      if (generation === this.generation) this.set({ ...this.state, error, loading: false })
    }
  }

  private start(): void {
    void this.refresh()
    this.timer = setInterval(() => {
      if (globalThis.document?.visibilityState !== 'hidden') void this.refresh()
    }, this.options.intervalMs)
  }

  private stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  private set(state: FeedState<T>): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}

/** One feed per key, created on first use. */
export class FeedFamily<K, T> {
  private readonly feeds = new Map<K, Feed<T>>()
  private readonly create: (key: K) => Feed<T>

  constructor(create: (key: K) => Feed<T>) {
    this.create = create
  }

  get(key: K): Feed<T> {
    let feed = this.feeds.get(key)
    if (!feed) {
      feed = this.create(key)
      this.feeds.set(key, feed)
    }
    return feed
  }
}
