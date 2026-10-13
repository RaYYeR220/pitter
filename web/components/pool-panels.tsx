'use client'

import { useState, type CSSProperties } from 'react'
import { CITIES, areaFromKey, cityArea } from '@/lib/cover/area'
import { copy } from '@/lib/copy'
import { formatCountdown, formatDay, formatDollars, formatPercent } from '@/lib/format'
import type { ActivityLine, PoolActionProblem, PoolDay } from '@/lib/pool'
import { useAccount } from '@/hooks/account'
import { usePoolAreaWeather } from '@/hooks/area-weather'
import { useWeather } from '@/hooks/money'
import { usePool, usePoolPosition } from '@/hooks/pool'
import { useRuntime } from '@/hooks/runtime'
import { AccountPanel } from './account-panel'
import { ProblemNote, RecordLink, RefusalNote, SourceNote } from './notes'
import { Figure } from './ui/figure'
import { Hairline } from './ui/hairline'
import { Meter, MeterCaps } from './ui/meter'
import { AsksAgain, Banner, Sheet } from './ui/notice'
import { Receipt, Receipts } from './ui/receipt'
import { Tile } from './ui/tile'

const CITY_KEYS = new Map(CITIES.map((city) => [cityArea(city).key, city.name]))

/** A name a person can place: the simulator, a city centre, or the area's coordinates. */
function useAreaName() {
  const { config } = useRuntime()
  const simulator = config.practice?.simulator.key ?? null
  return (key: bigint): string => {
    if (simulator !== null && key === simulator) return copy.area.simulator
    const city = CITY_KEYS.get(key)
    if (city) return copy.screen.pool.central(city)
    const place = areaFromKey(key, 'city', '')
    return copy.area.coordinates(place.lat, place.lon)
  }
}

const bpsShare = (bps: number) => `${bps / 100}%`

export function PoolOverview() {
  const pool = usePool()
  const weather = useWeather()
  const meters = pool.meters
  const areaWeather = usePoolAreaWeather(pool.data)
  const wet = meters?.areas.filter((area) => areaWeather?.get(area.key)?.raining) ?? []

  let state: string = copy.pool.intro
  if (meters) {
    if (meters.areas.length === 0) state = copy.screen.pool.stateNone
    else if (wet.length > 0) state = copy.screen.pool.stateRaining(wet.length, meters.areas.length)
    else state = copy.screen.pool.stateDry(meters.areas.length)
  }

  return (
    <section className="pool-lead" data-testid="pool" aria-labelledby="pool-h">
      <p className="mono pool-lead__clock">
        <b>{copy.pool.heading}</b>
        <span className={weather.fresh === false ? 'pool-lead__stale' : undefined}>
          <i className={`check__mark${weather.fresh === false ? ' check__mark--hollow' : ''}`} aria-hidden="true" />
          {weather.ageSeconds !== null
            ? weather.fresh === false
              ? copy.weather.silent
              : copy.weather.fresh(weather.ageSeconds)
            : copy.weather.unknown}
        </span>
      </p>
      <h1 className="sentence" id="pool-h">
        {state}
      </h1>
      {pool.error && !pool.data ? (
        <Banner tone="stop" alert>
          <p>{copy.pool.unavailable}</p>
        </Banner>
      ) : null}
      {!pool.data && !pool.error ? <p className="mono">{copy.status.loading}</p> : null}
      {meters && pool.data ? (
        <>
          <Figure value={formatDollars(meters.pool.used)} wipe label={copy.screen.pool.inUseLabel(meters.pool.used)} />
          <p className="figcap">{copy.screen.pool.inUseCaption}</p>
          <div className="pool-lead__meter">
            <Meter
              share={meters.pool.share}
              size="lg"
              label={copy.screen.pool.meterLabel(formatPercent(meters.pool.used, meters.pool.limit))}
            />
            <MeterCaps>
              <span>
                <b>{formatPercent(meters.pool.used, meters.pool.limit)}</b> {copy.screen.pool.ofLimit}
              </span>
              <span>
                <b>{formatDollars(meters.pool.room)}</b> {copy.screen.pool.room}
              </span>
              <span>
                {copy.screen.pool.limitIs} <b>{formatDollars(meters.pool.limit)}</b>,{' '}
                {copy.screen.pool.limitShare(bpsShare(pool.data.state.maxUtilizationBps))}
              </span>
            </MeterCaps>
          </div>
          <dl className="kpi">
            <div>
              <dt>{copy.pool.size}</dt>
              <dd className="kpi__value" data-testid="pool-total" data-units={meters.total.toString()}>
                {formatDollars(meters.total)}
              </dd>
              <dd className="mono">{copy.screen.pool.leaving(meters.leaving)}</dd>
            </div>
            <div>
              <dt>{copy.pool.active}</dt>
              <dd className="kpi__value" data-testid="pool-active" data-units={meters.active.toString()}>
                {formatDollars(meters.active)}
              </dd>
              <dd className="mono">{copy.screen.pool.activeSub}</dd>
            </div>
            <div>
              <dt>{copy.pool.free}</dt>
              <dd className="kpi__value">{formatDollars(meters.free)}</dd>
              <dd className="mono">{copy.screen.pool.freeSub}</dd>
            </div>
            <div>
              <dt>{copy.pool.areaLimit}</dt>
              <dd className="kpi__value">{formatDollars(meters.areaLimit)}</dd>
              <dd className="mono">{copy.screen.pool.areaLimitSub(bpsShare(pool.data.state.maxCellBps))}</dd>
            </div>
          </dl>
        </>
      ) : null}
      <p className="pool-lead__about">{copy.pool.intro}</p>
    </section>
  )
}

export function PoolAreas() {
  const pool = usePool()
  const meters = pool.meters
  const nameOf = useAreaName()
  const areaWeather = usePoolAreaWeather(pool.data)
  return (
    <section className="psec" data-testid="pool-areas" aria-labelledby="areas-h" id="areas">
      <h2 className="h-section" id="areas-h">
        {copy.pool.areas}
      </h2>
      {meters ? <p className="lede psec__lede">{copy.screen.pool.areasLede(meters.areaLimit)}</p> : null}
      {meters && meters.areas.length === 0 ? <p className="small dim">{copy.pool.noAreas}</p> : null}
      {meters && meters.areas.length > 0 ? (
        <div className="psplit psplit--flip">
          <div>
            <ul className="tiles" aria-label={copy.screen.pool.tilesLabel}>
              {meters.areas.map((area) => {
                const raining = areaWeather?.get(area.key)?.raining === true
                const name = nameOf(area.key)
                const percent = formatPercent(area.used, area.limit)
                return (
                  <Tile
                    key={area.key.toString()}
                    name={name}
                    value={formatDollars(area.used)}
                    sub={raining ? copy.screen.pool.tilePaying(percent) : percent}
                    share={area.share}
                    wet={raining}
                    label={copy.screen.pool.tileLabel(name, area.used, area.limit, raining)}
                  />
                )
              })}
            </ul>
            <p className="key mono">
              <span>
                <i className="key__well" aria-hidden="true" />
                {copy.screen.pool.keyWell}
              </span>
              <span>
                <i className="key__wet" aria-hidden="true" />
                {copy.screen.pool.keyWet}
              </span>
              <span>
                <i className="key__full" aria-hidden="true" />
                {copy.screen.pool.keyFull}
              </span>
            </p>
          </div>
          <div className="scroll">
            <table className="grid">
              <caption className="vh">{copy.screen.pool.tableCaption}</caption>
              <thead>
                <tr>
                  <th scope="col">{copy.screen.pool.colArea}</th>
                  <th scope="col" className="grid__meter">
                    {copy.screen.pool.colLimit}
                  </th>
                  <th scope="col" className="r">
                    {copy.pool.inUse}
                  </th>
                  <th scope="col" className="r grid__opt">
                    {copy.screen.pool.colRoom}
                  </th>
                  <th scope="col" className="r">
                    {copy.screen.pool.colCovers}
                  </th>
                </tr>
              </thead>
              <tbody>
                {meters.areas.map((area) => {
                  const raining = areaWeather?.get(area.key)?.raining === true
                  return (
                    <tr key={area.key.toString()} className={raining ? 'grid__wet' : undefined}>
                      <th scope="row">
                        {raining ? <i className="drops" aria-hidden="true" /> : null}
                        {nameOf(area.key)}
                        {raining ? <span className="vh">{copy.screen.pool.paying}</span> : null}
                      </th>
                      <td className="grid__meter">
                        <Meter
                          share={area.share}
                          size="sm"
                          label={copy.screen.pool.rowMeter(formatPercent(area.used, area.limit))}
                        />
                      </td>
                      <td className="r">{formatDollars(area.used)}</td>
                      <td className="r grid__opt">{formatDollars(area.room)}</td>
                      <td className="r">{area.openCover.toString()}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  )
}

/** Premiums in, payouts out, since the book opened: one dollar scale, payouts in the accent. */
function TotalsBars({ premiums, fees, payouts }: { premiums: bigint; fees: bigint; payouts: bigint }) {
  const top = [premiums, payouts, fees].reduce((a, b) => (b > a ? b : a), 1n)
  const share = (value: bigint) => Number((value * 10_000n) / top) / 10_000
  const bars = [
    { key: 'premiums', label: copy.pool.premiums, sub: copy.screen.pool.premiumsSub, value: premiums, tone: 'ink' },
    { key: 'payouts', label: copy.pool.payouts, sub: copy.screen.pool.payoutsSub, value: payouts, tone: 'rain' },
    { key: 'fees', label: copy.pool.fees, sub: copy.screen.pool.feesSub, value: fees, tone: 'quiet' },
  ] as const
  return (
    <dl className="hbars">
      {bars.map((bar) => (
        <div key={bar.key} className={`hbars__row hbars__row--${bar.tone}`}>
          <dt>
            {bar.label}
            <small className="mono">{bar.sub}</small>
          </dt>
          <dd className="hbars__value">{formatDollars(bar.value)}</dd>
          <dd className="hbars__track" aria-hidden="true">
            <i style={{ '--p': share(bar.value) } as CSSProperties} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

function ActivityReceipt({ line, nameOf }: { line: ActivityLine; nameOf: (key: bigint) => string }) {
  if (line.kind === 'weather') {
    return (
      <Receipt
        rain={line.wetSeconds > 0}
        what={copy.screen.pool.weatherLabel(line.wetSeconds)}
        when={nameOf(line.key)}
        record={<RecordLink hash={line.transactionHash} />}
      />
    )
  }
  return (
    <Receipt
      rain={line.kind === 'settled'}
      what={line.kind === 'bought' ? copy.screen.pool.boughtLabel : copy.screen.pool.settledLabel}
      amount={formatDollars(line.amount)}
      when={copy.screen.pool.eventWhen(line.id)}
      record={<RecordLink hash={line.transactionHash} />}
    />
  )
}

/** The last days of premiums, payouts and money added, newest first. */
function DailyTable({ days }: { days: readonly PoolDay[] }) {
  return (
    <div className="scroll">
      <table className="grid" data-testid="pool-days">
        <caption className="vh">{copy.screen.pool.daysCaption}</caption>
        <thead>
          <tr>
            <th scope="col">{copy.screen.pool.colDay}</th>
            <th scope="col" className="r">
              {copy.screen.pool.colPremiums}
            </th>
            <th scope="col" className="r">
              {copy.screen.pool.colPayouts}
            </th>
            <th scope="col" className="r grid__opt">
              {copy.screen.pool.colAdded}
            </th>
            <th scope="col" className="r" title={copy.screen.pool.ratioLabel}>
              {copy.screen.pool.colRatio}
            </th>
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.date} className={day.payouts > 0n ? 'grid__wet' : undefined}>
              <th scope="row">
                <time dateTime={day.date}>{formatDay(day.startsAt, 'UTC')}</time>
              </th>
              <td className="r">{formatDollars(day.premiums)}</td>
              <td className="r">{formatDollars(day.payouts)}</td>
              <td className="r grid__opt">{formatDollars(day.deposits)}</td>
              <td className="r">{copy.screen.pool.ratio(day.lossRatio)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function PoolTotals() {
  const pool = usePool()
  const nameOf = useAreaName()
  const recent = pool.recent.data
  return (
    <section className="psec" data-testid="pool-totals" aria-labelledby="totals-h" id="totals">
      <h2 className="h-section" id="totals-h">
        {copy.screen.pool.totalsHeading}
      </h2>
      <p className="lede psec__lede">{copy.screen.pool.totalsLede}</p>
      <div className="psplit">
        <div>
          {pool.data ? (
            <>
              <p className="totals__sold">{copy.pool.sold(pool.data.totals.covers)}</p>
              <TotalsBars
                premiums={pool.data.totals.premiums}
                fees={pool.data.totals.fees}
                payouts={pool.data.totals.payouts}
              />
              <p className="mono totals__net">{copy.screen.pool.net(pool.data.totals.net)}</p>
              {pool.data.days ? (
                <>
                  <h3 className="h-block">{copy.screen.pool.daysHeading}</h3>
                  <DailyTable days={pool.data.days} />
                </>
              ) : null}
            </>
          ) : (
            <p className="mono">{copy.status.loading}</p>
          )}
        </div>
        <div>
          <h3 className="h-block">{copy.pool.recent}</h3>
          {recent ? (
            <>
              <p className="mono recent__range">
                {recent.blocks === null
                  ? copy.pool.recentIndexed
                  : copy.pool.recentRange(recent.blocks, Math.round(recent.blocks * 0.4))}
              </p>
              {recent.lines.length === 0 ? (
                <p className="small dim">{recent.blocks === null ? copy.pool.recentEmpty : copy.pool.recentNone}</p>
              ) : null}
              <Receipts>
                {recent.lines.map((line) => (
                  <ActivityReceipt
                    key={`${line.transactionHash}-${line.kind}-${line.kind === 'weather' ? line.key : line.id}`}
                    line={line}
                    nameOf={nameOf}
                  />
                ))}
              </Receipts>
            </>
          ) : pool.recent.error ? (
            <p className="mono">{copy.pool.recentUnavailable}</p>
          ) : (
            <p className="mono">{copy.status.loading}</p>
          )}
        </div>
      </div>
      <SourceNote origin={pool.data?.origin} />
    </section>
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
    case 'cover':
      return copy.pool.leave.waitingForCover
    case 'nothing':
    case 'failed':
      return copy.pool.leave.failed
    case 'refused':
      return problem.refusal.message
  }
}

/** The backer's slip: what their share is worth, and adding to it. */
export function PoolPosition() {
  const account = useAccount()
  const position = usePoolPosition()
  const [amount, setAmount] = useState('')
  if (account.status !== 'signed_in') {
    return (
      <aside className="pool-aside" aria-label={copy.pool.position.heading}>
        <Sheet className="share">
          <h2 className="h-block">{copy.pool.position.heading}</h2>
          <p className="small">{copy.pool.position.signIn}</p>
        </Sheet>
        <AccountPanel variant="slip" />
      </aside>
    )
  }
  const data = position.data
  const leave = position.leave
  const busy = position.status === 'confirming' || position.status === 'sending'

  return (
    <aside className="pool-aside" aria-labelledby="share-h">
      <Sheet className="share" testId="pool-position" data={{ 'data-phase': leave?.phase ?? 'loading' }}>
        <h2 className="h-block" id="share-h">
          {copy.pool.position.heading}
        </h2>
        {data ? (
          <>
            {data.shares > 0n || data.request ? (
              <>
                <p className="share__big" data-testid="position-value" data-units={data.value.toString()}>
                  {formatDollars(data.value)}
                </p>
                <p className="mono">{copy.pool.position.value}</p>
              </>
            ) : (
              <p className="small">{copy.pool.position.none}</p>
            )}
            <p className="mono share__balance">{copy.pool.position.balance(data.dollars)}</p>
          </>
        ) : (
          <p className="mono">{copy.status.loading}</p>
        )}

        <form
          className="share__add"
          onSubmit={(event) => {
            event.preventDefault()
            void position.add(amount)
          }}
        >
          <p className="small">{copy.pool.position.addIntro}</p>
          <label className="field">
            <span>{copy.pool.position.amount}</span>
            <input
              className="input input--money"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              placeholder="500"
              data-testid="pool-amount"
            />
          </label>
          <button
            type="submit"
            className="btn btn--ink btn--wide"
            disabled={busy}
            data-testid="pool-add"
            aria-describedby="pool-add-asks"
          >
            {position.action === 'add' && position.status === 'sending' ? copy.status.working : copy.pool.position.add}
          </button>
          <AsksAgain id="pool-add-asks">{copy.screen.pool.addAsks}</AsksAgain>
        </form>
        {position.invalidAmount ? (
          <Banner tone="stop" alert>
            <p>{copy.money.invalidAmount}</p>
          </Banner>
        ) : null}
        {position.action === 'add' && position.status === 'confirming' ? (
          <Banner tone="wait" live>
            <p>{copy.account.confirm.pool_add}</p>
          </Banner>
        ) : null}
        {position.deposit ? (
          <Banner tone="done" live testId="pool-added">
            <p>
              {copy.pool.position.added(position.deposit.assets)} <RecordLink hash={position.deposit.transactionHash} />
            </p>
          </Banner>
        ) : null}
        <ProblemNote problem={position.problem} />
        <RefusalNote refusal={position.refusal} />
        {data && leave && leave.phase !== 'none' ? (
          <a className="btn btn--line btn--wide" href="#leave">
            {copy.pool.leave.heading}
          </a>
        ) : null}
      </Sheet>
    </aside>
  )
}

/** Leaving in three steps: ask, wait out the notice, take the money out. */
export function PoolLeave() {
  const position = usePoolPosition()
  const pool = usePool()
  const account = useAccount()
  if (account.status !== 'signed_in') return null
  const data = position.data
  const leave = position.leave
  if (!data || !leave || leave.phase === 'none') return null
  const busy = position.status === 'confirming' || position.status === 'sending'
  const notice = pool.data?.state.redeemNotice ?? 0
  const step = leave.phase === 'in' ? 0 : leave.phase === 'waiting' ? 1 : 2
  const problem = actionProblem(position.actionProblem)

  return (
    <section className="psec" data-testid="pool-leave" aria-labelledby="leave-h" id="leave">
      <h2 className="h-section" id="leave-h">
        {copy.pool.leave.heading}
      </h2>
      <p className="lede psec__lede">{copy.pool.leave.intro(notice)}</p>
      <p className="mono">{copy.pool.leave.fee}</p>
      {position.fee && !position.fee.ok ? (
        <Banner tone="wait">
          <p>{copy.pool.leave.noFee}</p>
        </Banner>
      ) : null}
      <ol className="steps">
        <li className={step === 0 ? 'steps__item steps__item--now' : 'steps__item'}>
          <p className="mono steps__k">{copy.screen.leave.step(1)}</p>
          <h3 className="steps__h">{copy.screen.leave.askTitle}</h3>
          <p className="small">{copy.screen.leave.askText}</p>
          {leave.phase === 'in' ? (
            <div className="steps__act">
              <button
                type="button"
                className="btn btn--line btn--wide"
                disabled={busy}
                onClick={() => void position.askToLeave()}
                aria-describedby="leave-asks"
              >
                {copy.pool.leave.ask}
              </button>
              <AsksAgain id="leave-asks">{copy.screen.pool.leaveAsks}</AsksAgain>
            </div>
          ) : null}
        </li>
        <li className={step === 1 ? 'steps__item steps__item--now' : 'steps__item'}>
          <p className="mono steps__k">{copy.screen.leave.step(2)}</p>
          <h3 className="steps__h">{copy.screen.leave.waitTitle}</h3>
          {leave.phase === 'waiting' ? (
            <>
              <p className="steps__count" data-testid="leave-countdown">
                {formatCountdown(leave.remainingMs)}
              </p>
              <p className="small">{copy.pool.leave.waiting(leave.remainingMs)}</p>
              <Hairline progress={notice > 0 ? 1 - leave.remainingMs / (notice * 1000) : 0} />
              <p className="small">{copy.pool.leave.asked}</p>
              <div className="steps__act">
                <button type="button" className="link" disabled={busy} onClick={() => void position.stay()}>
                  {copy.pool.leave.cancel}
                </button>
              </div>
            </>
          ) : (
            <p className="small">{copy.screen.leave.waitText(notice)}</p>
          )}
        </li>
        <li className={step === 2 ? 'steps__item steps__item--now' : 'steps__item'}>
          <p className="mono steps__k">{copy.screen.leave.step(3)}</p>
          <h3 className="steps__h">{copy.screen.leave.takeTitle}</h3>
          {leave.phase === 'ready' ? (
            <>
              {leave.blockedByCover ? (
                <p className="small" data-testid="leave-blocked">
                  {copy.pool.leave.waitingForCover}
                </p>
              ) : (
                <>
                  <p className="small">{copy.pool.leave.ready(leave.claimableAssets)}</p>
                  {leave.partly ? <p className="mono">{copy.pool.leave.readyPartly}</p> : null}
                </>
              )}
              <div className="steps__act">
                <button
                  type="button"
                  className="btn btn--ink btn--wide"
                  disabled={busy || leave.claimableShares === 0n}
                  onClick={() => void position.takeOut()}
                  aria-describedby="take-asks"
                >
                  {copy.pool.leave.take}
                </button>
                <AsksAgain id="take-asks">{copy.screen.pool.leaveAsks}</AsksAgain>
                <button type="button" className="link" disabled={busy} onClick={() => void position.stay()}>
                  {copy.pool.leave.cancel}
                </button>
              </div>
            </>
          ) : (
            <p className="small">{copy.screen.leave.takeText}</p>
          )}
        </li>
      </ol>
      {position.action !== 'add' && position.status === 'confirming' ? (
        <Banner tone="wait" live>
          <p>{copy.account.confirm.pool_leave}</p>
        </Banner>
      ) : null}
      {position.action !== 'add' && position.status === 'done' ? (
        <Banner tone="done" live>
          <p>
            {position.action === 'cancel'
              ? copy.pool.leave.cancelled
              : position.action === 'take'
                ? copy.pool.leave.taken
                : copy.pool.leave.asked}
          </p>
        </Banner>
      ) : null}
      {problem ? (
        <Banner tone="stop" alert>
          <p>{problem}</p>
        </Banner>
      ) : null}
    </section>
  )
}
