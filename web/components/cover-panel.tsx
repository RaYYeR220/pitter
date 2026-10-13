'use client'

import { useState, type CSSProperties, type ReactNode } from 'react'
import { copy } from '@/lib/copy'
import type { PriceView } from '@/lib/cover/quote'
import type { StopReason } from '@/lib/cover/engine'
import type { PriceSlot } from '@/lib/service/client'
import { formatDollars, perMinute } from '@/lib/format'
import { COVER_DEFAULTS } from '@/lib/config'
import { useAccount } from '@/hooks/account'
import { useAccrual, useArea, useBalance, useCover, useLockShift } from '@/hooks/cover'
import { useWeather } from '@/hooks/money'
import { useRuntime } from '@/hooks/runtime'
import { RefusalNote, RecordLink } from './notes'
import { Figure } from './ui/figure'
import { Hairline } from './ui/hairline'
import { Meter, MeterCaps } from './ui/meter'
import { AsksAgain, Banner, Block, Sheet } from './ui/notice'
import { Rain } from './ui/rain'
import { Row, Rows } from './ui/rows'
import { CoverSwitch } from './ui/switch'
import { useFlood } from './ui/theme'

const pad = (value: number) => value.toString().padStart(2, '0')

/** Time on cover as a clock: "1:18" and ":02". */
function elapsed(seconds: number): { main: string; sub: string } {
  const total = Math.max(0, Math.floor(seconds))
  return { main: `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}`, sub: `:${pad(total % 60)}` }
}

/** Dollars to the cent, with the tenth of a cent as a separate digit that turns every second or so. */
function counting(units: bigint): { main: string; sub: string } {
  const safe = units > 0n ? units : 0n
  return { main: formatDollars((safe / 10_000n) * 10_000n), sub: ((safe % 10_000n) / 1000n).toString() }
}

/** Seconds it takes a payout rate (millionths of a dollar a second) to earn one cent. */
function secondsPerCent(ratePerSecond: bigint | null): number {
  if (!ratePerSecond || ratePerSecond <= 0n) return 5
  return Math.max(1, Math.round(10_000 / Number(ratePerSecond)))
}

function stopMessage(reason: StopReason): string {
  switch (reason.kind) {
    case 'refused':
      return reason.refusal.message
    case 'session_expired':
      return copy.cover.stopped.session_expired
    case 'spend_limit':
      return copy.cover.stopped.spend_limit(reason.limit)
    case 'insufficient_balance':
      return copy.cover.stopped.insufficient_balance
    case 'unavailable':
      return copy.cover.stopped.unavailable
  }
}

/** Chance of heavy rain in each quarter hour of a price, as thin bars against the same scale. */
function ForecastBars({ slots }: { slots: PriceSlot[] }) {
  if (slots.length < 3) return null
  const top = Math.max(0.05, ...slots.map((slot) => slot.probabilityWet))
  const width = 100 / slots.length
  const wettest = slots.reduce((best, slot) => (slot.probabilityWet > best.probabilityWet ? slot : best), slots[0]!)
  return (
    <figure className="bars">
      <div className="bars__plot" role="img" aria-label={copy.screen.price.barsLabel(slots.length, wettest.probabilityWet)}>
        {slots.map((slot) => (
          <span
            key={slot.start}
            className="bars__bar"
            style={{ '--h': slot.probabilityWet / top, width: `${width}%` } as CSSProperties}
            title={`${copy.price.slot(slot.start, slot.end)}: ${copy.price.chance(slot.probabilityWet)}`}
          />
        ))}
      </div>
      <figcaption className="mono bars__caps">
        <span>{copy.price.slot(slots[0]!.start, slots.at(-1)!.end)}</span>
        <span>{copy.screen.price.barsTop(top)}</span>
      </figcaption>
    </figure>
  )
}

/** The forecast behind a price, multiplied out. */
export function WhyThisPrice({ price, testId = 'why-price' }: { price: PriceView | null; testId?: string }) {
  if (!price) return null
  const margin = price.why ? price.premium - price.why.expectedPayout : 0n
  return (
    <details className="why" data-testid={testId}>
      <summary className="why__summary">{copy.price.show}</summary>
      <Sheet className="why__sheet">
        <p className="small">{copy.price.intro}</p>
        {price.why ? (
          <>
            <ForecastBars slots={price.why.slots} />
            <div className="why__table">
              <table>
                <caption className="vh">{copy.price.heading}</caption>
                <tbody>
                  {price.why.slots.map((slot) => (
                    <tr key={slot.start}>
                      <th scope="row" className="mono">
                        {copy.price.slot(slot.start, slot.end)}
                      </th>
                      <td>
                        {copy.price.chance(slot.probabilityWet)}
                        <small className="mono">{copy.price.basis[slot.basis]}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ol className="math">
              <li>
                <span>{copy.screen.price.expectedLabel}</span>
                <b>{formatDollars(price.why.expectedPayout)}</b>
              </li>
              <li>
                <span>{copy.price.load(price.why.loadBps)}</span>
                <b>{formatDollars(margin)}</b>
              </li>
              <li className="math__sum">
                <span>{copy.price.total(price.premium)}</span>
                <b>{copy.screen.price.perMinute(price.costPerMinute)}</b>
              </li>
            </ol>
            <div className="split" aria-hidden="true">
              <i style={{ flex: Number(price.why.expectedPayout) || 1 }} />
              <i style={{ flex: Number(margin) || 0 }} />
            </div>
            <p className="mono split__caps" aria-hidden="true">
              <span>{copy.screen.price.splitExpected}</span>
              <span>{copy.screen.price.splitMargin}</span>
            </p>
          </>
        ) : (
          <>
            <p className="mono">{copy.price.unavailable}</p>
            <p className="why__total">{copy.price.total(price.premium)}</p>
          </>
        )}
      </Sheet>
    </details>
  )
}

/** Where cover is for: the area, and a way to change it while cover is off. */
export function AreaPicker({ locked }: { locked: boolean }) {
  const area = useArea()
  const [changing, setChanging] = useState(false)
  const open = !locked && (area.area === null || changing)
  const done = () => setChanging(false)
  const selectedCity =
    area.area?.source === 'city' ? (area.cities.find((city) => area.area?.label.endsWith(city.name))?.name ?? '') : ''

  return (
    <div className="row area" data-testid="area">
      <dt>
        {copy.area.heading}
        {area.area ? (
          <small className="mono">{copy.area.coordinates(area.area.lat, area.area.lon)}</small>
        ) : (
          <small className="mono">{copy.area.none}</small>
        )}
      </dt>
      <dd>
        {area.area ? (
          <span className="area__name" data-testid="area-label" data-key={area.area.key.toString()}>
            {area.area.source === 'simulator' ? copy.area.simulator : copy.area.about(area.area.label)}
          </span>
        ) : null}
        {area.area && !locked ? (
          <button type="button" className="link area__change" aria-expanded={open} onClick={() => setChanging(!changing)}>
            {changing ? copy.status.close : copy.area.change}
          </button>
        ) : null}
      </dd>
      {open ? (
        <dd className="row__more area__pick">
          <div className="area__buttons">
            <button
              type="button"
              className="btn btn--quiet"
              disabled={area.locating}
              onClick={() => void area.useLocation().then(done)}
            >
              {area.locating ? copy.area.locating : copy.area.useLocation}
            </button>
            {area.simulatorAvailable ? (
              <button
                type="button"
                className="btn btn--sim"
                onClick={() => {
                  area.useSimulator()
                  done()
                }}
                data-testid="use-simulator"
              >
                {copy.practice.useArea}
              </button>
            ) : null}
          </div>
          <label className="field">
            <span>{copy.area.pickCity}</span>
            <select
              className="select"
              value={selectedCity}
              onChange={(event) => {
                area.chooseCity(event.target.value)
                if (event.target.value) done()
              }}
            >
              <option value="">{copy.area.choose}</option>
              {area.cities.map((city) => (
                <option key={city.name} value={city.name}>
                  {city.name}
                </option>
              ))}
            </select>
          </label>
          <p className="mono">{copy.area.privacy}</p>
        </dd>
      ) : null}
      {area.problem ? (
        <dd className="row__more">
          <Banner tone="stop" alert>
            <p>{copy.area[area.problem]}</p>
          </Banner>
        </dd>
      ) : null}
      {area.area?.source === 'simulator' ? (
        <dd className="row__more">
          <p className="mono">{copy.area.simulatorNote}</p>
        </dd>
      ) : null}
    </div>
  )
}

/** What cover pays per minute of heavy rain: three pills. */
function PayoutChoice({ locked }: { locked: boolean }) {
  const area = useArea()
  return (
    <div className="row">
      <dt>
        {copy.cover.payoutChoice}
        <small className="mono">{copy.screen.payout.sub}</small>
      </dt>
      <dd>
        <span>{formatDollars(perMinute(area.ratePerSecond))}</span>
        <small className="mono">{copy.screen.payout.unit}</small>
      </dd>
      <dd className="row__more">
        <fieldset className="chips" data-testid="rate" disabled={locked}>
          <legend className="vh">{copy.cover.payoutChoice}</legend>
          {area.rates.map((rate) => (
            <label key={rate.toString()} className="chip">
              <input
                type="radio"
                name="rate"
                value={rate.toString()}
                checked={area.ratePerSecond === rate}
                onChange={() => area.setRate(rate)}
              />
              <span>{formatDollars(perMinute(rate))}</span>
            </label>
          ))}
        </fieldset>
      </dd>
    </div>
  )
}

function BalanceRow() {
  const balance = useBalance()
  const { config } = useRuntime()
  const empty = balance.data !== null && balance.data.dollars === 0n
  return (
    <Row
      label={copy.money.balance}
      sub={empty ? (config.practice ? copy.screen.balance.emptyPractice : copy.screen.balance.empty) : undefined}
      value={
        balance.data
          ? formatDollars(balance.data.dollars)
          : balance.error
            ? copy.screen.balance.unknown
            : copy.screen.balance.reading
      }
      valueProps={
        balance.data ? { 'data-testid': 'balance', 'data-units': balance.data.dollars.toString() } : undefined
      }
    />
  )
}

/** The current shift as it accrues: paid, confirmed, and still counting since the last weather check. */
export function AccrualPanel() {
  const accrual = useAccrual()
  const account = useAccount()
  if (account.status !== 'signed_in' || !accrual.shift) return null
  const earned = accrual.paid + accrual.confirmed + accrual.provisional
  const net = accrual.paid + accrual.confirmed - accrual.cost
  return (
    <div className="accrual" data-testid="accrual">
      <p className="accrual__title mono">{copy.screen.accrual.title(accrual.shift.start, accrual.shift.end)}</p>
      {earned > 0n ? (
        <div className="stack" aria-hidden="true">
          <i className="stack__paid" style={{ flex: Number(accrual.paid) }} />
          <i className="stack__confirmed" style={{ flex: Number(accrual.confirmed) }} />
          <i className="stack__counting" style={{ flex: Number(accrual.provisional) }} />
        </div>
      ) : null}
      <Rows className="rows--tight">
        <Row
          className="row--paid"
          label={copy.accrual.paid}
          sub={copy.screen.accrual.paidSub}
          value={formatDollars(accrual.paid)}
          valueProps={{ 'data-testid': 'paid', 'data-units': accrual.paid.toString() }}
        />
        <Row
          className="row--confirmed"
          label={copy.accrual.confirmed}
          sub={copy.screen.accrual.confirmedSub}
          value={formatDollars(accrual.confirmed)}
          valueProps={{ 'data-testid': 'confirmed', 'data-units': accrual.confirmed.toString() }}
        />
        <Row
          className="row--counting"
          label={copy.accrual.provisional}
          sub={accrual.provisional > 0n ? copy.accrual.provisionalNote : copy.screen.accrual.countingSub}
          value={formatDollars(accrual.provisional)}
          valueProps={{ 'data-testid': 'provisional', 'data-units': accrual.provisional.toString() }}
        />
        <Row label={copy.accrual.cost} value={formatDollars(accrual.cost)} />
        <Row className="row--total" label={copy.screen.accrual.net} value={formatDollars(net, { sign: true })} />
      </Rows>
    </div>
  )
}

/** The latest weather check: for the area of the running cover, else the newest anywhere. */
function WeatherLine() {
  const accrual = useAccrual()
  const weather = useWeather()
  const checked = accrual.weather?.lastCheckedAt ?? null
  const stale = weather.fresh === false
  let text: string
  if (checked !== null && accrual.weather) text = copy.accrual.lastCheck(checked, accrual.weather.raining)
  else if (weather.ageSeconds !== null) text = stale ? copy.weather.silent : copy.weather.fresh(weather.ageSeconds)
  else text = copy.weather.unknown
  return (
    <p className={`check mono${stale ? ' check--stale' : ''}`}>
      <i className="check__mark" aria-hidden="true" />
      <span>{text}</span>
    </p>
  )
}

type Phase = 'idle' | 'offer' | 'starting' | 'waiting' | 'dry' | 'raining' | 'summary' | 'refused'

/** The switch, and every sentence about what cover is doing right now. */
export function CoverPanel() {
  const account = useAccount()
  const cover = useCover()
  const accrual = useAccrual()
  const weather = useWeather()
  const area = useArea()
  const signedIn = account.status === 'signed_in'
  const raining = accrual.running && accrual.weather?.raining === true
  useFlood(raining)
  const price = cover.price
  const now = accrual.at
  const on = cover.status === 'on'
  const locked = on

  let headline: string = on ? copy.cover.on : copy.cover.off
  if (on && cover.blocks.length === 0) headline = copy.cover.starting

  let phase: Phase
  if (raining) phase = 'raining'
  else if (accrual.running) phase = 'dry'
  else if (on && cover.blocks[0]) phase = 'waiting'
  else if (on) phase = 'starting'
  else if (cover.priceRefusal) phase = 'refused'
  else if (accrual.shift) phase = 'summary'
  else if (price) phase = 'offer'
  else phase = 'idle'

  const rate = accrual.ratePerSecond ?? area.ratePerSecond
  const lastBlock = cover.blocks.at(-1) ?? null
  const coveredUntil = accrual.coveredUntil ?? cover.coveredUntil
  const blockStart = lastBlock && coveredUntil && lastBlock.end === coveredUntil ? lastBlock.start : (accrual.shift?.start ?? now)
  const earned = accrual.paid + accrual.confirmed + accrual.provisional

  let figure: ReactNode = null
  let caption: ReactNode = null
  let hair: ReactNode = (
    <Hairline progress={1} marks={10} left={copy.screen.hair.line} />
  )

  switch (phase) {
    case 'idle':
      figure = <Figure value={formatDollars(perMinute(area.ratePerSecond))} wipe />
      caption = <p className="figcap">{area.area ? copy.screen.cap.pricing : copy.screen.cap.idle}</p>
      break
    case 'offer':
      figure = <Figure value={formatDollars(price!.costPerMinute)} wipe />
      caption = (
        <p className="figcap" data-testid="offer">
          {copy.screen.cap.offer(price!.ratePerSecond)}
        </p>
      )
      break
    case 'starting':
      figure = <Figure value={price ? formatDollars(price.costPerMinute) : '0:00'} />
      caption = <p className="figcap">{copy.screen.cap.buying}</p>
      hair = <Hairline mode="loop" periodSeconds={2.4} left={copy.screen.cap.buying} right="" />
      break
    case 'waiting': {
      const start = cover.blocks[0]!.start
      const left = Math.max(0, start - now)
      figure = <Figure value={`${Math.floor(left / 60)}:${pad(left % 60)}`} label={copy.cover.waitingToStart(start)} />
      caption = <p className="figcap">{copy.cover.waitingToStart(start)}</p>
      break
    }
    case 'dry': {
      const time = elapsed(now - (accrual.shift?.start ?? now))
      figure = <Figure value={time.main} sub={time.sub} label={copy.screen.cap.onSinceLabel(accrual.shift?.start ?? now)} />
      caption = (
        <p className="figcap" data-testid="dry">
          {copy.screen.cap.dry(accrual.shift?.start ?? now)}
        </p>
      )
      if (coveredUntil) {
        const span = Math.max(1, coveredUntil - blockStart)
        hair = (
          <Hairline
            progress={(now - blockStart) / span}
            marks={Math.max(1, Math.round(span / 60) > 12 ? 4 : Math.round(span / 60))}
            left={copy.cover.coveredUntil(coveredUntil)}
            right={
              on ? copy.screen.hair.renews(coveredUntil - COVER_DEFAULTS.renewLeadSeconds) : copy.screen.hair.noMore
            }
          />
        )
      }
      break
    }
    case 'raining': {
      const count = counting(earned)
      figure = (
        <Figure
          value={count.main}
          sub={count.sub}
          label={copy.screen.cap.earnedLabel(formatDollars(earned))}
          className="fig--rain"
        />
      )
      caption = (
        <p className="figcap" data-testid="raining">
          {copy.screen.cap.raining(rate)}
        </p>
      )
      hair = (
        <Hairline
          mode="loop"
          marks={3}
          periodSeconds={secondsPerCent(rate) * 3}
          left={copy.screen.hair.cent(secondsPerCent(rate))}
          right={copy.screen.hair.final}
        />
      )
      break
    }
    case 'summary':
      figure = <Figure value={formatDollars(accrual.paid + accrual.confirmed)} wipe />
      caption = (
        <p className="figcap">
          {accrual.paid + accrual.confirmed > 0n ? copy.screen.cap.summaryPaid : copy.screen.cap.summaryDry}
        </p>
      )
      hair = null
      break
    case 'refused': {
      const refusal = cover.priceRefusal!
      if (refusal.capacity) {
        const capacity = refusal.capacity
        const needed = area.ratePerSecond * BigInt(COVER_DEFAULTS.blockSeconds)
        figure = <Figure value={formatDollars(capacity.available)} wipe />
        caption = <p className="figcap">{copy.screen.cap.room(needed)}</p>
        const share = capacity.cellLimit > 0n ? Number((capacity.cellExposure * 10_000n) / capacity.cellLimit) / 10_000 : 1
        hair = (
          <div className="limitbox">
            <Meter
              share={share}
              overflow={capacity.available < needed}
              label={copy.screen.cap.meterLabel(capacity.cellExposure, capacity.cellLimit)}
            />
            <MeterCaps>
              <span>
                <b>{formatDollars(capacity.cellExposure)}</b> {copy.pool.inUse.toLowerCase()}
              </span>
              <span>
                {copy.screen.cap.limit} <b>{formatDollars(capacity.cellLimit)}</b>
              </span>
            </MeterCaps>
          </div>
        )
      } else if (refusal.kind === 'weather_silent' && weather.ageSeconds !== null) {
        figure = <Figure value={copy.screen.cap.age(weather.ageSeconds)} wipe />
        caption = <p className="figcap">{copy.screen.cap.silent}</p>
        hair = <Hairline mode="broken" left={copy.screen.hair.unconfirmed} right={copy.screen.hair.paused} />
      } else {
        figure = <Figure value={formatDollars(perMinute(area.ratePerSecond))} wipe />
        caption = <p className="figcap">{copy.screen.cap.notNow}</p>
      }
      break
    }
  }

  if (weather.fresh === false && phase !== 'refused') {
    hair = <Hairline mode="broken" left={copy.screen.hair.unconfirmed} right={copy.screen.hair.paused} />
  }

  return (
    <section
      className={`screen cover cover--${phase}`}
      aria-labelledby="cover-h"
      data-testid="cover"
      data-status={cover.status}
      data-activity={cover.activity}
      data-raining={String(raining)}
    >
      {raining ? <Rain heavy className="cover__rain" /> : null}
      <div className="screen__lead">
        <h1 className="sentence" id="cover-h" data-testid="cover-headline">
          {headline}
        </h1>
        {phase === 'raining' ? <p className="sentence sentence--second">{copy.screen.state.raining}</p> : null}
        {phase === 'dry' ? <p className="sentence sentence--second">{copy.screen.state.dry}</p> : null}
        {figure}
        {caption}
        {phase === 'offer' || phase === 'idle' || phase === 'starting' ? <WhyThisPrice price={price} /> : null}
        {hair}
        {phase === 'offer' && price ? (
          <div className="pair">
            <div>
              <b>{formatDollars(price.premium)}</b>
              <span>{copy.screen.offer.cost(Math.round(price.seconds / 60))}</span>
            </div>
            <div>
              <b>{formatDollars(price.maxPayout)}</b>
              <span>{copy.screen.offer.pays}</span>
            </div>
          </div>
        ) : null}
        {phase === 'raining' ? (
          <div className="pair">
            <div>
              <b>{copy.screen.rain.minutes(rainSeconds(accrual, earned))}</b>
              <span>{copy.screen.rain.minutesCaption}</span>
            </div>
            <div>
              <b>{formatDollars(perMinute(rate))}</b>
              <span>{copy.screen.rain.rateCaption}</span>
            </div>
          </div>
        ) : null}

        <div className="notes">
          {weather.fresh === false ? (
            <Banner tone="wait" testId="weather-silent">
              <p>{copy.weather.silent}</p>
            </Banner>
          ) : null}
          {cover.stopped ? (
            <Banner tone="stop" alert testId="cover-stopped" data={{ 'data-kind': cover.stopped.kind }}>
              <p>{stopMessage(cover.stopped)}</p>
              {cover.stopped.kind === 'refused' && cover.stopped.refusal.capacity ? (
                <p className="mono">{copy.refusals.capacity(cover.stopped.refusal.capacity.available)}</p>
              ) : null}
            </Banner>
          ) : null}
          {!on ? <RefusalNote refusal={cover.priceRefusal} /> : null}
          {cover.retrying ? <RefusalNote refusal={cover.retrying} /> : null}
          {cover.activity === 'confirming' ? (
            <Banner tone="wait" live>
              <p>{copy.refusals.pending}</p>
            </Banner>
          ) : null}
          {cover.gaps.map((gap) => (
            <p key={gap.from} className="mono">
              {copy.cover.gap(gap.from, gap.to)}
            </p>
          ))}
        </div>
      </div>

      <div className="screen__side">
        <Rows>
          <AreaPicker locked={locked} />
          <PayoutChoice locked={locked} />
          <BalanceRow />
        </Rows>
        <AccrualPanel />
        <div className="actions actions--switch">
          {phase === 'summary' && price ? (
            <p className="side-offer" data-testid="offer">
              {copy.screen.cap.offerAgain(price.costPerMinute, price.ratePerSecond)}
            </p>
          ) : null}
          <CoverSwitch
            on={on}
            disabled={on ? false : !cover.canTurnOn}
            busy={cover.activity === 'buying' || cover.activity === 'confirming'}
            label={on ? copy.cover.on : copy.cover.turnOn}
            sub={on ? copy.screen.switch.onSub : copy.screen.switch.offSub(COVER_DEFAULTS.blockSeconds)}
            onToggle={on ? cover.turnOff : () => void cover.turnOn()}
            testId={on ? 'turn-off' : 'turn-on'}
            describedBy="switch-note"
          />
          <p className="mono switch-note" id="switch-note">
            {!signedIn
              ? copy.account.intro
              : !on && !area.area
                ? copy.screen.switch.needArea
                : on
                  ? copy.cover.renews
                  : copy.cover.noRefund}
          </p>
        </div>
        <WeatherLine />
        <p className="mono fine">{copy.cover.heavyRain}</p>
        {lastBlock?.transactionHash ? (
          <p className="mono last-record">
            {copy.screen.lastBought(lastBlock.start, lastBlock.end)} <RecordLink hash={lastBlock.transactionHash} />
          </p>
        ) : null}
      </div>
    </section>
  )
}

/** Seconds of heavy rain this shift has been paid or is counting for, at each piece of cover's own rate. */
function rainSeconds(accrual: ReturnType<typeof useAccrual>, earned: bigint): number {
  if (!accrual.shift) return 0
  let seconds = 0
  for (const record of accrual.shift.records) {
    if (record.ratePerSecond > 0n) seconds += Number((record.paid + record.confirmed) / record.ratePerSecond)
  }
  if (accrual.ratePerSecond && accrual.ratePerSecond > 0n) seconds += Number(accrual.provisional / accrual.ratePerSecond)
  return earned > 0n ? seconds : 0
}

export function LockShiftPanel() {
  const lock = useLockShift()
  const cover = useCover()
  const account = useAccount()
  if (account.status !== 'signed_in' || !cover.area) return null
  const offer = lock.offer
  return (
    <Block
      id="lock"
      title={copy.cover.lock.heading}
      lede={copy.cover.lock.intro}
      testId="lock-shift"
      data={{ 'data-status': lock.status }}
    >
      <div className="lock__controls">
        <label className="field">
          <span>{copy.cover.lock.length}</span>
          <select className="select" value={lock.hours} onChange={(event) => lock.setHours(Number(event.target.value))}>
            {lock.hourOptions.map((hours) => (
              <option key={hours} value={hours}>
                {copy.cover.lock.hours(hours)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn--line"
          disabled={lock.status === 'pricing' || lock.status === 'buying'}
          onClick={() => void lock.getPrice()}
        >
          {lock.status === 'pricing' ? copy.status.working : copy.cover.lock.getPrice}
        </button>
      </div>
      {offer && lock.status !== 'done' ? (
        <Sheet className="offer">
          <Figure value={formatDollars(offer.price.premium)} size="slip" />
          <p className="figcap">{copy.cover.lock.price(offer.price.premium, offer.price.start, offer.price.end)}</p>
          <Rows className="rows--tight">
            <Row label={copy.screen.lock.upTo} value={formatDollars(offer.price.maxPayout)} />
            <Row label={copy.screen.lock.perMinute} value={formatDollars(offer.price.costPerMinute)} unit={copy.screen.payout.minute} />
            <Row label={copy.cover.payoutChoice} value={formatDollars(perMinute(offer.price.ratePerSecond))} unit={copy.screen.payout.minute} />
          </Rows>
          <WhyThisPrice price={offer.price} testId="why-lock-price" />
          <div className="actions">
            <button
              type="button"
              className="btn btn--ink btn--wide"
              disabled={lock.status !== 'priced'}
              onClick={() => void lock.lock()}
              aria-describedby={lock.needsConfirmation ? 'lock-asks' : undefined}
            >
              {copy.cover.lock.confirm}
            </button>
            {lock.needsConfirmation ? (
              <AsksAgain id="lock-asks">{copy.account.confirm.cover_over_limit}</AsksAgain>
            ) : (
              <p className="mono">{copy.screen.lock.noPrompt}</p>
            )}
          </div>
        </Sheet>
      ) : null}
      {lock.status === 'done' && lock.bought ? (
        <Banner tone="done" live>
          <p>
            {copy.cover.lock.locked(lock.bought.end)}{' '}
            {lock.bought.transactionHash ? <RecordLink hash={lock.bought.transactionHash} /> : null}
          </p>
        </Banner>
      ) : null}
      <RefusalNote refusal={lock.refusal} />
      {lock.problem ? (
        <Banner tone="stop" alert>
          <p>{lock.problem.title}</p>
        </Banner>
      ) : null}
    </Block>
  )
}
