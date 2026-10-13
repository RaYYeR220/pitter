'use client'

import { copy } from '@/lib/copy'
import { useAccount } from '@/hooks/account'
import { useWeather } from '@/hooks/money'
import { AccountPanel } from './account-panel'
import { CoverPanel, LockShiftPanel } from './cover-panel'
import { HistoryPanel, MoneyPanel, PracticePanel } from './money-panel'
import { PoolAreas, PoolLeave, PoolOverview, PoolPosition, PoolTotals } from './pool-panels'
import { Ready } from './shell'
import { ShiftLogPanel } from './shift-log-panel'
import { Banner } from './ui/notice'

function SendingStatus() {
  const { health } = useWeather()
  if (!health || health.relayer.balance === 'ok' || health.relayer.balance === 'unknown') return null
  return (
    <div className="page-note">
      <Banner tone={health.relayer.balance === 'empty' ? 'stop' : 'wait'}>
        <p>{health.relayer.balance === 'empty' ? copy.status.relayerEmpty : copy.status.relayerLow}</p>
      </Banner>
    </div>
  )
}

function CoverBody() {
  const account = useAccount()
  const signedIn = account.status === 'signed_in'
  return (
    <div className="page page--app">
      <SendingStatus />
      {signedIn ? (
        <>
          <AccountPanel />
          <CoverPanel />
        </>
      ) : (
        <AccountPanel />
      )}
      <PracticePanel />
      {signedIn ? (
        <div className="ledger-grid">
          <div className="ledger-grid__main">
            <HistoryPanel />
            <ShiftLogPanel />
          </div>
          <div className="ledger-grid__side">
            <MoneyPanel />
            <LockShiftPanel />
          </div>
        </div>
      ) : (
        <ShiftLogPanel />
      )}
    </div>
  )
}

export function CoverScreen() {
  return (
    <Ready>
      <CoverBody />
    </Ready>
  )
}

function PoolBody() {
  const account = useAccount()
  return (
    <div className="page page--pool">
      <SendingStatus />
      {account.status === 'signed_in' ? <AccountPanel /> : null}
      <div className="pool-hero">
        <PoolOverview />
        <PoolPosition />
      </div>
      <PoolAreas />
      <PoolTotals />
      <PoolLeave />
    </div>
  )
}

export function PoolScreen() {
  return (
    <Ready>
      <PoolBody />
    </Ready>
  )
}
