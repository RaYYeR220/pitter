'use client'

import { useCallback } from 'react'
import type { AccountState } from '@/lib/account'
import { SESSION_DEFAULTS } from '@/lib/config'
import { useNow, useRuntime, useStore } from './runtime'

export interface UseAccount extends AccountState {
  /** One passkey prompt that creates the account and signs in. */
  signUp(): Promise<boolean>
  /** One passkey prompt. `anyAccount` lets the device offer every passkey of this site instead of the last one. */
  signIn(anyAccount?: boolean): Promise<boolean>
  signOut(): void
}

export function useAccount(): UseAccount {
  const { account } = useRuntime()
  const state = useStore(account)
  const signUp = useCallback(() => account.signUp(), [account])
  const signIn = useCallback((anyAccount = false) => account.signIn({}, anyAccount), [account])
  const signOut = useCallback(() => account.signOut(), [account])
  return { ...state, signUp, signIn, signOut }
}

export interface SessionClock {
  /** Time left before the sign-in ends whatever happens. */
  remainingMs: number
  /** Time left before it ends for lack of use; null while cover is on. */
  idleRemainingMs: number | null
  /** The sign-in ends within a few minutes; time to offer a renewal. */
  expiring: boolean
  maxSpendPerHour: bigint
  spentThisHour: bigint
  spendRemaining: bigint
}

/** The visible countdown of the sign-in and of its hourly limit. Null while signed out. */
export function useSessionClock(): SessionClock | null {
  const { account } = useRuntime()
  useStore(account)
  useNow(1000)
  const timing = account.timing()
  if (!timing) return null
  const soonest = Math.min(timing.remainingMs, timing.idleRemainingMs ?? Infinity)
  return {
    remainingMs: timing.remainingMs,
    idleRemainingMs: timing.idleRemainingMs,
    expiring: soonest <= SESSION_DEFAULTS.warnMs,
    maxSpendPerHour: timing.maxSpendPerHour,
    spentThisHour: timing.spentThisHour,
    spendRemaining: timing.spendRemaining,
  }
}
