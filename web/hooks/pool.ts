'use client'

import { useCallback, useState } from 'react'
import { CeremonyError, type AccountProblem } from '@/lib/account'
import type { PoolPosition } from '@/lib/chain/reader'
import { refusalFrom, type Refusal } from '@/lib/cover/refusals'
import type { FeedState } from '@/lib/feed'
import { parseDollars } from '@/lib/format'
import {
  PoolActionError,
  depositToPool,
  feeCheck,
  leavePool,
  leaveState,
  poolMeters,
  type FeeCheck,
  type LatestActivity,
  type LeaveState,
  type LeaveStep,
  type PoolActionProblem,
  type PoolMeters,
} from '@/lib/pool'
import type { PoolView } from '@/lib/runtime'
import type { DepositReceipt } from '@/lib/service/client'
import { useFeedOrEmpty } from './cover'
import { useNow, useRuntime, useStore } from './runtime'

export interface UsePool extends FeedState<PoolView> {
  meters: PoolMeters | null
  /** The latest sales, payouts and weather checks: the indexer's newest, or what the latest blocks hold. */
  recent: FeedState<LatestActivity>
  refresh(): Promise<void>
}

export function usePool(): UsePool {
  const { feeds } = useRuntime()
  const pool = useStore(feeds.pool)
  const recent = useStore(feeds.recent)
  return {
    ...pool,
    meters: pool.data ? poolMeters(pool.data.state) : null,
    recent,
    refresh: useCallback(async () => {
      await Promise.all([feeds.pool.refresh(), feeds.recent.refresh()])
    }, [feeds]),
  }
}

export type PoolActionStatus = 'idle' | 'confirming' | 'sending' | 'done' | 'failed'

export interface UsePoolPosition extends FeedState<PoolPosition> {
  leave: LeaveState | null
  /** Whether the account can pay the network fee leaving takes. */
  fee: FeeCheck | null
  status: PoolActionStatus
  /** The action in progress or last finished. */
  action: 'add' | LeaveStep | null
  problem: AccountProblem | null
  actionProblem: PoolActionProblem | null
  refusal: Refusal | null
  invalidAmount: boolean
  deposit: DepositReceipt | null
  /** Adds dollars to the pool, behind a fresh passkey prompt and without a fee. */
  add(amount: string): Promise<void>
  /** Asks to leave with everything. Sent from the account itself, so it needs MON. */
  askToLeave(): Promise<void>
  /** Takes out what the finished notice allows. */
  takeOut(): Promise<void>
  /** Withdraws the request to leave. */
  stay(): Promise<void>
}

/** The signed-in backer's share of the pool and the steps to add to it or leave it. */
export function usePoolPosition(): UsePoolPosition {
  const runtime = useRuntime()
  const { account, feeds, reader, service, chain, config } = runtime
  const { address } = useStore(account)
  const feed = address ? feeds.position.get(address) : null
  const position = useFeedOrEmpty(feed)
  const now = useNow(1000)
  const [status, setStatus] = useState<PoolActionStatus>('idle')
  const [action, setAction] = useState<UsePoolPosition['action']>(null)
  const [problem, setProblem] = useState<AccountProblem | null>(null)
  const [actionProblem, setActionProblem] = useState<PoolActionProblem | null>(null)
  const [refused, setRefused] = useState<Refusal | null>(null)
  const [invalidAmount, setInvalidAmount] = useState(false)
  const [deposit, setDeposit] = useState<DepositReceipt | null>(null)

  const begin = (next: UsePoolPosition['action']) => {
    setAction(next)
    setStatus('confirming')
    setProblem(null)
    setActionProblem(null)
    setRefused(null)
    setInvalidAmount(false)
  }

  const fail = (error: unknown) => {
    if (error instanceof CeremonyError) setProblem(error.problem)
    else if (error instanceof PoolActionError) setActionProblem(error.problem)
    else setRefused(refusalFrom(error))
    setStatus('failed')
  }

  const refreshAll = useCallback(() => {
    void feed?.refresh()
    void feeds.pool.refresh()
    if (address) void feeds.balance.get(address).refresh()
  }, [feed, feeds, address])

  const add = useCallback(
    async (text: string) => {
      const amount = parseDollars(text)
      if (amount === null || amount <= 0n) {
        setInvalidAmount(true)
        return
      }
      begin('add')
      setDeposit(null)
      try {
        const receipt = await account.confirm('pool_add', (key) => {
          setStatus('sending')
          return depositToPool({
            account: key,
            amount,
            reader,
            service,
            pool: config.contracts.coverPool,
            now: Math.floor(Date.now() / 1000),
          })
        })
        setDeposit(receipt)
        setStatus('done')
      } catch (error) {
        fail(error)
      } finally {
        refreshAll()
      }
    },
    [account, reader, service, config, refreshAll],
  )

  const leaveStep = useCallback(
    async (step: LeaveStep, shares: bigint) => {
      begin(step)
      try {
        await account.confirm('pool_leave', (key) => {
          setStatus('sending')
          return leavePool(step, shares, { account: key, publicClient: chain, config })
        })
        setStatus('done')
      } catch (error) {
        fail(error)
      } finally {
        refreshAll()
      }
    },
    [account, chain, config, refreshAll],
  )

  const data = position.data
  const leave = data ? leaveState(data, now) : null

  return {
    ...position,
    leave,
    fee: data ? feeCheck(data.native, null) : null,
    status,
    action,
    problem,
    actionProblem,
    refusal: refused,
    invalidAmount,
    deposit,
    add,
    askToLeave: useCallback(async () => {
      if (data && data.shares > 0n) await leaveStep('request', data.shares)
    }, [data, leaveStep]),
    takeOut: useCallback(async () => {
      if (data && data.claimableShares > 0n) await leaveStep('take', data.claimableShares)
    }, [data, leaveStep]),
    stay: useCallback(async () => {
      if (data?.request) await leaveStep('cancel', 0n)
    }, [data, leaveStep]),
  }
}
