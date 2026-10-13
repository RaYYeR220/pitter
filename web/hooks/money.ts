'use client'

import { useCallback, useState } from 'react'
import { CeremonyError, type AccountProblem } from '@/lib/account'
import { cashOut, checkCashOut, type CashOutInputProblem } from '@/lib/cover/cashout'
import { refusalFrom, type Refusal } from '@/lib/cover/refusals'
import type { HealthReport } from '@/lib/config'
import type { FeedState } from '@/lib/feed'
import type { PracticeRain, TransferReceipt, WeatherCheck } from '@/lib/service/client'
import { isServiceFailure } from '@/lib/service/errors'
import { useBalance, useFeedOrEmpty } from './cover'
import { useRuntime, useStore } from './runtime'

export type CashOutStatus = 'idle' | 'confirming' | 'sending' | 'done' | 'failed'

export interface UseCashOut {
  status: CashOutStatus
  /** What is wrong with what was typed; nothing was sent. */
  inputProblem: CashOutInputProblem | null
  /** The passkey prompt did not go through. */
  problem: AccountProblem | null
  refusal: Refusal | null
  receipt: TransferReceipt | null
  /** Checks the input, then asks for Face ID or fingerprint, then sends. */
  submit(input: { to: string; amount: string }): Promise<void>
  reset(): void
}

/** Cash-out: a fresh passkey prompt every time, then a transfer the service sends without a fee. */
export function useCashOut(): UseCashOut {
  const { account, reader, service } = useRuntime()
  const { address } = useStore(account)
  const balance = useBalance()
  const [status, setStatus] = useState<CashOutStatus>('idle')
  const [inputProblem, setInputProblem] = useState<CashOutInputProblem | null>(null)
  const [problem, setProblem] = useState<AccountProblem | null>(null)
  const [refused, setRefused] = useState<Refusal | null>(null)
  const [receipt, setReceipt] = useState<TransferReceipt | null>(null)

  const reset = useCallback(() => {
    setStatus('idle')
    setInputProblem(null)
    setProblem(null)
    setRefused(null)
    setReceipt(null)
  }, [])

  const submit = useCallback(
    async (input: { to: string; amount: string }) => {
      reset()
      if (!address) return
      const checked = checkCashOut(input, address, balance.data?.dollars ?? 0n)
      if (!checked.ok) {
        setInputProblem(checked.problem)
        return
      }
      setStatus('confirming')
      try {
        const sent = await account.confirm('cash_out', (key) => {
          setStatus('sending')
          return cashOut({
            account: key,
            to: checked.to,
            amount: checked.amount,
            reader,
            service,
            now: Math.floor(Date.now() / 1000),
          })
        })
        setReceipt(sent)
        setStatus('done')
      } catch (error) {
        if (error instanceof CeremonyError) setProblem(error.problem)
        else setRefused(refusalFrom(error))
        setStatus('failed')
      } finally {
        void balance.refresh()
      }
    },
    [account, address, balance, reader, service, reset],
  )

  return { status, inputProblem, problem, refusal: refused, receipt, submit, reset }
}

export interface UseWeather {
  /** Whether the weather was checked recently enough for cover to be sold. Null when unknown. */
  fresh: boolean | null
  ageSeconds: number | null
  health: HealthReport | null
}

/** When the weather was last checked, from the server's health report. */
export function useWeather(): UseWeather {
  const { feeds, health } = useRuntime()
  const state = useStore(feeds.health)
  const report = state.data ?? health
  return { fresh: report.weather.fresh, ageSeconds: report.weather.ageSeconds, health: report }
}

export type PracticeStatus = 'idle' | 'working' | 'done' | 'failed'

export interface UsePractice {
  /** False outside practice mode: nothing below may be shown then. */
  available: boolean
  money: { status: PracticeStatus; amount: bigint | null; limited: boolean }
  getMoney(): Promise<void>
  rain: FeedState<PracticeRain>
  setRain(wet: boolean): Promise<void>
  rainStatus: PracticeStatus
  check: { status: PracticeStatus; result: WeatherCheck | null }
  checkWeather(): Promise<void>
}

/** Practice-mode tools: practice dollars, the simulator's rain switch and an immediate weather check. */
export function usePractice(): UsePractice {
  const { config, service, feeds, account } = useRuntime()
  const { address } = useStore(account)
  const balance = useBalance()
  const rain = useFeedOrEmpty(feeds.rain)
  const [money, setMoney] = useState<UsePractice['money']>({ status: 'idle', amount: null, limited: false })
  const [rainStatus, setRainStatus] = useState<PracticeStatus>('idle')
  const [check, setCheck] = useState<UsePractice['check']>({ status: 'idle', result: null })

  const getMoney = useCallback(async () => {
    if (!address) return
    setMoney({ status: 'working', amount: null, limited: false })
    try {
      const result = await service.practiceMoney(address)
      setMoney({ status: 'done', amount: result.amount, limited: false })
    } catch (error) {
      const limited = isServiceFailure(error) && error.code === 'drip_limited'
      setMoney({ status: 'failed', amount: null, limited })
    } finally {
      void balance.refresh()
    }
  }, [service, address, balance])

  const setRain = useCallback(
    async (wet: boolean) => {
      setRainStatus('working')
      try {
        await service.setPracticeRain(wet)
        setRainStatus('done')
      } catch {
        setRainStatus('failed')
      } finally {
        void feeds.rain?.refresh()
      }
    },
    [service, feeds],
  )

  const checkWeather = useCallback(async () => {
    setCheck({ status: 'working', result: null })
    try {
      const result = await service.practiceWeatherCheck()
      setCheck({ status: 'done', result })
    } catch {
      setCheck({ status: 'failed', result: null })
    } finally {
      void feeds.health.refresh()
      void balance.refresh()
      if (address) void feeds.history.get(address).refresh()
    }
  }, [service, feeds, balance, address])

  return {
    available: config.practice !== null,
    money,
    getMoney,
    rain,
    setRain,
    rainStatus,
    check,
    checkWeather,
  }
}
