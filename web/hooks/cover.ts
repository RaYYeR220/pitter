'use client'

import { useCallback, useEffect, useState } from 'react'
import { toAuthorization, receiveAuthorization } from '@/lib/chain/erc3009'
import type { AccountBalances } from '@/lib/chain/reader'
import { COVER_DEFAULTS } from '@/lib/config'
import { computeAccrual, type Accrual } from '@/lib/cover/accrual'
import { CITIES, type City, type ExactPosition } from '@/lib/cover/area'
import {
  NeedsConfirmation,
  RefusalError,
  type CoverBlock,
  type CoverEngineState,
  type ShiftOffer,
} from '@/lib/cover/engine'
import type { CoverSnapshot } from '@/lib/cover/history'
import { refusal, refusalFrom, type Refusal } from '@/lib/cover/refusals'
import type { SelectionState } from '@/lib/cover/selection'
import type { FeedState } from '@/lib/feed'
import { CeremonyError, type AccountProblem } from '@/lib/account'
import { useNow, useRuntime, useStore } from './runtime'

export interface UseArea extends SelectionState {
  cities: readonly City[]
  simulatorAvailable: boolean
  /** Asks the device where it is. Resolves to the exact position, for the shift log only, or null. */
  useLocation(): Promise<ExactPosition | null>
  chooseCity(name: string): void
  useSimulator(): void
  setRate(ratePerSecond: bigint): void
  rates: readonly bigint[]
  clear(): void
}

export function useArea(): UseArea {
  const { selection } = useRuntime()
  const state = useStore(selection)
  return {
    ...state,
    cities: CITIES,
    simulatorAvailable: selection.simulatorAvailable,
    rates: COVER_DEFAULTS.rates,
    useLocation: useCallback(() => selection.useLocation(), [selection]),
    chooseCity: useCallback((name: string) => selection.chooseCity(name), [selection]),
    useSimulator: useCallback(() => selection.useSimulator(), [selection]),
    setRate: useCallback((rate: bigint) => selection.setRate(rate), [selection]),
    clear: useCallback(() => selection.clear(), [selection]),
  }
}

export interface UseCover extends CoverEngineState {
  /** Whether the switch can be turned on: signed in, an area chosen, cover off. */
  canTurnOn: boolean
  turnOn(): Promise<void>
  turnOff(): void
  /** Looks up the current price for the chosen area and payout, without buying. */
  refreshPrice(): Promise<void>
}

/** The cover switch and everything the engine knows. */
export function useCover(): UseCover {
  const { engine, selection, account } = useRuntime()
  const state = useStore(engine)
  const { area, ratePerSecond } = useStore(selection)
  const { status } = useStore(account)
  const signedIn = status === 'signed_in'

  const refreshPrice = useCallback(async () => {
    if (area) await engine.preview(area, ratePerSecond)
  }, [engine, area, ratePerSecond])

  useEffect(() => {
    if (signedIn && area && state.status === 'off') void engine.preview(area, ratePerSecond)
  }, [engine, signedIn, area, ratePerSecond, state.status])

  return {
    ...state,
    canTurnOn: signedIn && area !== null && state.status === 'off',
    turnOn: useCallback(async () => {
      if (area) await engine.turnOn(area, ratePerSecond)
    }, [engine, area, ratePerSecond]),
    turnOff: useCallback(() => engine.turnOff(), [engine]),
    refreshPrice,
  }
}

export type LockShiftStatus = 'idle' | 'pricing' | 'priced' | 'buying' | 'confirming' | 'done' | 'failed'

export interface UseLockShift {
  hours: number
  hourOptions: readonly number[]
  setHours(hours: number): void
  status: LockShiftStatus
  offer: ShiftOffer | null
  /** Whether buying it will need Face ID or fingerprint, because it is above the hourly limit. */
  needsConfirmation: boolean
  bought: CoverBlock | null
  refusal: Refusal | null
  problem: AccountProblem | null
  getPrice(): Promise<void>
  lock(): Promise<void>
  reset(): void
}

/** "Lock the price for my shift": price a whole shift now, then buy it at that price. */
export function useLockShift(): UseLockShift {
  const { engine, selection, account, reader, config } = useRuntime()
  const { area, ratePerSecond } = useStore(selection)
  const [hours, setHours] = useState<number>(COVER_DEFAULTS.defaultShiftHours)
  const [status, setStatus] = useState<LockShiftStatus>('idle')
  const [offer, setOffer] = useState<ShiftOffer | null>(null)
  const [bought, setBought] = useState<CoverBlock | null>(null)
  const [refused, setRefused] = useState<Refusal | null>(null)
  const [problem, setProblem] = useState<AccountProblem | null>(null)

  const reset = useCallback(() => {
    setStatus('idle')
    setOffer(null)
    setBought(null)
    setRefused(null)
    setProblem(null)
  }, [])

  useEffect(reset, [reset, area, ratePerSecond, hours])

  const getPrice = useCallback(async () => {
    if (!area) return
    setStatus('pricing')
    setRefused(null)
    setProblem(null)
    try {
      setOffer(await engine.quoteShift(area, ratePerSecond, hours * 3600))
      setStatus('priced')
    } catch (error) {
      setRefused(error instanceof RefusalError ? error.refusal : refusalFrom(error))
      setStatus('failed')
    }
  }, [engine, area, ratePerSecond, hours])

  const lock = useCallback(async () => {
    if (!offer) return
    setStatus('buying')
    try {
      setBought(await engine.lockShift(offer))
      setStatus('done')
      return
    } catch (error) {
      if (!(error instanceof NeedsConfirmation)) {
        setRefused(error instanceof RefusalError ? error.refusal : refusalFrom(error))
        setStatus('failed')
        return
      }
    }
    setStatus('confirming')
    try {
      const block = await account.confirm('cover_over_limit', (key) =>
        engine.lockShift(offer, async (payment) => {
          const domain = await reader.tokenDomain()
          const message = { from: key.address, to: config.contracts.coverBook, ...payment }
          return toAuthorization(message, await key.signTypedData(receiveAuthorization(domain, message)))
        }),
      )
      setBought(block)
      setStatus('done')
    } catch (error) {
      if (error instanceof CeremonyError) setProblem(error.problem)
      else setRefused(error instanceof RefusalError ? error.refusal : refusalFrom(error))
      setStatus('failed')
    }
  }, [engine, account, reader, config, offer])

  const signer = account.coverSigner()
  const needsConfirmation = offer !== null && signer !== null && !signer.check(offer.signed.quote.premium).allowed

  return {
    hours,
    hourOptions: COVER_DEFAULTS.shiftHours,
    setHours,
    status,
    offer,
    needsConfirmation,
    bought,
    refusal:
      refused ??
      (status === 'priced' && offer && Date.now() / 1000 > offer.price.expiresAt ? refusal('quote_expired') : null),
    problem,
    getPrice,
    lock,
    reset,
  }
}

/** The signed-in holder's cover and payouts, read from the chain and refreshed while shown. */
export function useCoverHistory(): FeedState<CoverSnapshot> & { refresh(): Promise<void> } {
  const { feeds, account, engine } = useRuntime()
  const { address } = useStore(account)
  const feed = address ? feeds.history.get(address) : null
  const state = useFeedOrEmpty(feed)
  const { blocks } = useStore(engine)
  useEffect(() => {
    if (feed && blocks.length > 0) void feed.refresh()
  }, [feed, blocks.length])
  return { ...state, refresh: useCallback(async () => feed?.refresh(), [feed]) }
}

/** The current shift as it accrues: paid, confirmed, and likely since the last weather check. */
export function useAccrual(): Accrual & { at: number } {
  const history = useCoverHistory()
  const now = Math.floor(useNow(1000) / 1000)
  const empty: CoverSnapshot = { at: now, records: [], weather: new Map() }
  return { ...computeAccrual(history.data ?? empty, now), at: now }
}

/** The signed-in account's balance. */
export function useBalance(): FeedState<AccountBalances> & { refresh(): Promise<void> } {
  const { feeds, account, engine } = useRuntime()
  const { address } = useStore(account)
  const feed = address ? feeds.balance.get(address) : null
  const state = useFeedOrEmpty(feed)
  const { blocks } = useStore(engine)
  useEffect(() => {
    if (feed && blocks.length > 0) void feed.refresh()
  }, [feed, blocks.length])
  return { ...state, refresh: useCallback(async () => feed?.refresh(), [feed]) }
}

const EMPTY_STATE: FeedState<never> = { data: null, error: null, loading: false, updatedAt: null }
const EMPTY_FEED = { subscribe: () => () => undefined, getState: () => EMPTY_STATE }

export function useFeedOrEmpty<T>(
  feed: { subscribe(listener: () => void): () => void; getState(): FeedState<T> } | null,
) {
  return useStore((feed ?? EMPTY_FEED) as { subscribe(listener: () => void): () => void; getState(): FeedState<T> })
}
