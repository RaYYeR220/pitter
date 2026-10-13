'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { createRuntime, type Runtime } from '@/lib/runtime'

export type RuntimeStatus =
  | { status: 'loading' }
  | { status: 'ready'; runtime: Runtime }
  | { status: 'failed'; retry: () => void }

const RuntimeContext = createContext<RuntimeStatus>({ status: 'loading' })

let shared: Promise<Runtime> | null = null

/** One runtime per page load, kept across client-side navigation and dropped on reload. */
function loadRuntime(): Promise<Runtime> {
  shared ??= createRuntime().catch((error: unknown) => {
    shared = null
    throw error
  })
  return shared
}

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart'] as const

/**
 * Starts the app and runs what has to keep running whichever page is open: the sign-in clock, the cover
 * engine's tick and the reset of everything account-specific when the account changes.
 */
export function RuntimeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RuntimeStatus>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    loadRuntime().then(
      (runtime) => !cancelled && setState({ status: 'ready', runtime }),
      () => !cancelled && setState({ status: 'failed', retry: () => setAttempt((value) => value + 1) }),
    )
    return () => {
      cancelled = true
    }
  }, [attempt])

  const runtime = state.status === 'ready' ? state.runtime : null

  useEffect(() => {
    if (!runtime) return
    const { account, engine, shiftLog } = runtime
    account.restoreHint()

    const touch = () => account.touch()
    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, touch, { passive: true })

    const tick = () => {
      account.evaluate()
      void engine.tick()
    }
    const timer = setInterval(tick, 1000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisible)

    let address = account.getState().address
    let lastAccount = address
    const unsubscribe = account.subscribe(() => {
      const next = account.getState().address
      if (next === address) return
      const switched = next !== null && lastAccount !== null && next !== lastAccount
      const ended = next === null ? account.getState().ended : null
      if (switched || ended === 'signed_out') engine.reset()
      if (switched || ended !== null) shiftLog.lock()
      address = next
      if (next !== null) lastAccount = next
    })

    return () => {
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, touch)
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      unsubscribe()
    }
  }, [runtime])

  return <RuntimeContext.Provider value={state}>{children}</RuntimeContext.Provider>
}

export function useRuntimeStatus(): RuntimeStatus {
  return useContext(RuntimeContext)
}

/** The runtime. Only call it under a component that renders once the status is `ready`. */
export function useRuntime(): Runtime {
  const state = useContext(RuntimeContext)
  if (state.status !== 'ready') throw new Error('the app has not started yet')
  return state.runtime
}

/** Subscribes to anything with `subscribe` and `getState`. */
export function useStore<T>(store: { subscribe: (listener: () => void) => () => void; getState: () => T }): T {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}

/** The current time, updated every `intervalMs`. Unix milliseconds. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  const update = useCallback(() => setNow(Date.now()), [])
  useEffect(() => {
    const timer = setInterval(update, intervalMs)
    document.addEventListener('visibilitychange', update)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', update)
    }
  }, [intervalMs, update])
  return now
}
