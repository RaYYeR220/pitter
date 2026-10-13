'use client'

import Link from 'next/link'
import { copy } from '@/lib/copy'
import { useRuntimeStatus } from '@/hooks/runtime'
import { useWeather } from '@/hooks/money'
import { AccountPanel } from './account-panel'
import { AccrualPanel, AreaPicker, CoverPanel, LockShiftPanel } from './cover-panel'
import { HistoryPanel, MoneyPanel, PracticePanel } from './money-panel'
import { PoolOverview, PoolPosition } from './pool-panels'
import { Ready } from './shell'
import { ShiftLogPanel } from './shift-log-panel'

export function Landing() {
  const state = useRuntimeStatus()
  const practice = state.status === 'ready' && state.runtime.config.practice !== null
  return (
    <section>
      <h1>{copy.landing.claim}</h1>
      <p>{copy.landing.support}</p>
      <p>
        <Link href="/app" data-testid="landing-cta">
          <button type="button">{copy.landing.button}</button>
        </Link>
      </p>
      {practice ? <p className="muted">{copy.landing.practice}</p> : null}
    </section>
  )
}

function SendingStatus() {
  const { health } = useWeather()
  if (!health || health.relayer.balance === 'ok' || health.relayer.balance === 'unknown') return null
  return (
    <p className={`note ${health.relayer.balance === 'empty' ? 'bad' : 'warn'}`}>
      {health.relayer.balance === 'empty' ? copy.status.relayerEmpty : copy.status.relayerLow}
    </p>
  )
}

export function CoverScreen() {
  return (
    <Ready>
      <SendingStatus />
      <AccountPanel />
      <CoverPanel />
      <AreaPicker />
      <AccrualPanel />
      <MoneyPanel />
      <PracticePanel />
      <LockShiftPanel />
      <HistoryPanel />
      <ShiftLogPanel />
    </Ready>
  )
}

export function PoolScreen() {
  return (
    <Ready>
      <SendingStatus />
      <PoolOverview />
      <PoolPosition />
    </Ready>
  )
}
