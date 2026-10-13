'use client'

import { useState } from 'react'
import { areaFromKey } from '@/lib/cover/area'
import { copy } from '@/lib/copy'
import { formatDollars, formatPercent } from '@/lib/format'
import type { PoolActionProblem } from '@/lib/pool'
import { useAccount } from '@/hooks/account'
import { useWeather } from '@/hooks/money'
import { usePool, usePoolPosition } from '@/hooks/pool'
import { AccountPanel } from './account-panel'
import { ProblemNote, RecordLink, RefusalNote } from './notes'

function MeterRow({ label, used, limit }: { label: string; used: bigint; limit: bigint }) {
  return (
    <div>
      <p>
        {label}: {copy.pool.inUseOf(used, limit)} ({formatPercent(used, limit)})
      </p>
      <meter min={0} max={1} value={limit > 0n ? Number((used * 1000n) / limit) / 1000 : 0} />
    </div>
  )
}

export function PoolOverview() {
  const pool = usePool()
  const weather = useWeather()
  const meters = pool.meters

  return (
    <>
      <section data-testid="pool">
        <h2>{copy.pool.heading}</h2>
        <p>{copy.pool.intro}</p>
        {pool.error && !pool.data ? <p className="warn">{copy.pool.unavailable}</p> : null}
        {!pool.data && !pool.error ? <p>{copy.status.loading}</p> : null}
        {meters ? (
          <>
            <dl>
              <dt>{copy.pool.size}</dt>
              <dd data-testid="pool-total" data-units={meters.total.toString()}>
                {formatDollars(meters.total)}
              </dd>
              <dt>{copy.pool.active}</dt>
              <dd data-testid="pool-active" data-units={meters.active.toString()}>
                {formatDollars(meters.active)}
              </dd>
              <dt>{copy.pool.free}</dt>
              <dd>{formatDollars(meters.free)}</dd>
            </dl>
            <MeterRow label={copy.pool.inUse} used={meters.pool.used} limit={meters.pool.limit} />
            <p className="muted">
              {copy.pool.areaLimit}: {formatDollars(meters.areaLimit)}
            </p>
          </>
        ) : null}
        {weather.ageSeconds !== null ? (
          <p className={weather.fresh === false ? 'warn' : 'muted'}>
            {weather.fresh === false ? copy.weather.silent : copy.weather.fresh(weather.ageSeconds)}
          </p>
        ) : (
          <p className="muted">{copy.weather.unknown}</p>
        )}
      </section>

      <section data-testid="pool-areas">
        <h2>{copy.pool.areas}</h2>
        {meters && meters.areas.length === 0 ? <p>{copy.pool.noAreas}</p> : null}
        {meters?.areas.map((area) => {
          const place = areaFromKey(area.key, 'city', '')
          return (
            <MeterRow
              key={area.key.toString()}
              label={copy.pool.areaRow(place.lat, place.lon, area.openCover)}
              used={area.used}
              limit={area.limit}
            />
          )
        })}
      </section>

      <section data-testid="pool-totals">
        <h2>{copy.pool.totals}</h2>
        {pool.data ? (
          <>
            <p>{copy.pool.sold(pool.data.totals.covers)}</p>
            <dl>
              <dt>{copy.pool.premiums}</dt>
              <dd>{formatDollars(pool.data.totals.premiums)}</dd>
              <dt>{copy.pool.fees}</dt>
              <dd>{formatDollars(pool.data.totals.fees)}</dd>
              <dt>{copy.pool.payouts}</dt>
              <dd>{formatDollars(pool.data.totals.payouts)}</dd>
            </dl>
          </>
        ) : null}
        <h3>{copy.pool.recent}</h3>
        {pool.recent.data ? (
          <>
            <p className="muted">{copy.pool.recentRange(pool.recent.data.blocks, Math.round(pool.recent.data.blocks * 0.4))}</p>
            {pool.recent.data.events.length === 0 ? <p>{copy.pool.recentNone}</p> : null}
            <ul className="plain">
              {pool.recent.data.events.map((event) => (
                <li key={`${event.transactionHash}-${event.kind}-${event.id}`}>
                  {event.kind === 'bought' ? copy.pool.bought(event.amount) : copy.pool.settled(event.amount)}{' '}
                  <RecordLink hash={event.transactionHash} />
                </li>
              ))}
            </ul>
          </>
        ) : pool.recent.error ? (
          <p className="warn">{copy.pool.recentUnavailable}</p>
        ) : null}
      </section>
    </>
  )
}

function actionProblem(problem: PoolActionProblem | null): string | null {
  if (!problem) return null
  switch (problem.kind) {
    case 'fee':
      return copy.pool.leave.noFee
    case 'notice':
    case 'locked':
      return copy.pool.leave.readyPartly
    case 'nothing':
    case 'failed':
      return copy.pool.leave.failed
    case 'refused':
      return problem.refusal.message
  }
}

export function PoolPosition() {
  const account = useAccount()
  const position = usePoolPosition()
  const pool = usePool()
  const [amount, setAmount] = useState('')
  if (account.status !== 'signed_in') {
    return (
      <>
        <section>
          <h2>{copy.pool.position.heading}</h2>
          <p>{copy.pool.position.signIn}</p>
        </section>
        <AccountPanel />
      </>
    )
  }
  const data = position.data
  const leave = position.leave
  const busy = position.status === 'confirming' || position.status === 'sending'

  return (
    <>
      <AccountPanel />
      <section data-testid="pool-position" data-phase={leave?.phase ?? 'loading'}>
        <h2>{copy.pool.position.heading}</h2>
        {data ? (
          <>
            {data.shares > 0n || data.request ? (
              <dl>
                <dt>{copy.pool.position.value}</dt>
                <dd data-testid="position-value" data-units={data.value.toString()}>
                  {formatDollars(data.value)}
                </dd>
              </dl>
            ) : (
              <p>{copy.pool.position.none}</p>
            )}
            <p className="muted">{copy.pool.position.balance(data.dollars)}</p>
          </>
        ) : (
          <p>{copy.status.loading}</p>
        )}

        <h3>{copy.pool.position.add}</h3>
        <p>{copy.pool.position.addIntro}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void position.add(amount)
          }}
        >
          <label>
            {copy.pool.position.amount}
            <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" data-testid="pool-amount" />
          </label>
          <button type="submit" disabled={busy} data-testid="pool-add">
            {copy.pool.position.add}
          </button>
        </form>
        {position.invalidAmount ? <p className="note warn">{copy.money.invalidAmount}</p> : null}
        {position.action === 'add' && position.status === 'confirming' ? <p>{copy.account.confirm.pool_add}</p> : null}
        {position.action === 'add' && position.status === 'sending' ? <p>{copy.status.working}</p> : null}
        {position.deposit ? (
          <p className="note good" data-testid="pool-added">
            {copy.pool.position.added(position.deposit.assets)} <RecordLink hash={position.deposit.transactionHash} />
          </p>
        ) : null}
        <ProblemNote problem={position.problem} />
        <RefusalNote refusal={position.refusal} />
      </section>

      {data && leave && leave.phase !== 'none' ? (
        <section data-testid="pool-leave">
          <h2>{copy.pool.leave.heading}</h2>
          <p>{copy.pool.leave.intro(pool.data?.state.redeemNotice ?? 0)}</p>
          <p className="muted">{copy.pool.leave.fee}</p>
          {position.fee && !position.fee.ok ? <p className="note warn">{copy.pool.leave.noFee}</p> : null}
          {leave.phase === 'in' ? (
            <button type="button" className="secondary" disabled={busy} onClick={() => void position.askToLeave()}>
              {copy.pool.leave.ask}
            </button>
          ) : null}
          {leave.phase === 'waiting' ? (
            <>
              <p>{copy.pool.leave.asked}</p>
              <p data-testid="leave-countdown">{copy.pool.leave.waiting(leave.remainingMs)}</p>
              <button type="button" className="secondary" disabled={busy} onClick={() => void position.stay()}>
                {copy.pool.leave.cancel}
              </button>
            </>
          ) : null}
          {leave.phase === 'ready' ? (
            <>
              <p>{copy.pool.leave.ready(leave.claimableAssets)}</p>
              {leave.partly ? <p className="muted">{copy.pool.leave.readyPartly}</p> : null}
              <div className="row">
                <button type="button" disabled={busy || leave.claimableShares === 0n} onClick={() => void position.takeOut()}>
                  {copy.pool.leave.take}
                </button>
                <button type="button" className="secondary" disabled={busy} onClick={() => void position.stay()}>
                  {copy.pool.leave.cancel}
                </button>
              </div>
            </>
          ) : null}
          {position.action !== 'add' && position.status === 'confirming' ? <p>{copy.account.confirm.pool_leave}</p> : null}
          {position.action !== 'add' && position.status === 'done' ? (
            <p className="good">
              {position.action === 'cancel'
                ? copy.pool.leave.cancelled
                : position.action === 'take'
                  ? copy.pool.leave.taken
                  : copy.pool.leave.asked}
            </p>
          ) : null}
          {actionProblem(position.actionProblem) ? <p className="note bad">{actionProblem(position.actionProblem)}</p> : null}
        </section>
      ) : null}
    </>
  )
}
