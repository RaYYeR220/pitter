'use client'

import { copy } from '@/lib/copy'
import type { PriceView } from '@/lib/cover/quote'
import type { StopReason } from '@/lib/cover/engine'
import { formatDollars } from '@/lib/format'
import { useAccount } from '@/hooks/account'
import { useAccrual, useArea, useCover, useLockShift } from '@/hooks/cover'
import { useWeather } from '@/hooks/money'
import { RefusalNote, RecordLink } from './notes'

export function AreaPicker() {
  const area = useArea()
  const cover = useCover()
  const locked = cover.status === 'on'
  return (
    <section data-testid="area">
      <h2>{copy.area.heading}</h2>
      {area.area ? (
        <p data-testid="area-label" data-key={area.area.key.toString()}>
          {area.area.source === 'simulator' ? copy.area.simulator : copy.area.about(area.area.label)}
          <br />
          <span className="muted">{copy.area.coordinates(area.area.lat, area.area.lon)}</span>
        </p>
      ) : (
        <p>{copy.area.none}</p>
      )}
      {area.area?.source === 'simulator' ? <p className="muted">{copy.area.simulatorNote}</p> : null}
      {area.problem ? (
        <p className="note warn" role="alert">
          {copy.area[area.problem]}
        </p>
      ) : null}
      <div className="row">
        <button
          type="button"
          className="secondary"
          disabled={locked || area.locating}
          onClick={() => void area.useLocation()}
        >
          {area.locating ? copy.area.locating : copy.area.useLocation}
        </button>
        {area.simulatorAvailable ? (
          <button
            type="button"
            className="secondary"
            disabled={locked}
            onClick={area.useSimulator}
            data-testid="use-simulator"
          >
            {copy.practice.useArea}
          </button>
        ) : null}
      </div>
      <label>
        {copy.area.pickCity}
        <select
          disabled={locked}
          value={
            area.area?.source === 'city'
              ? (area.cities.find((city) => area.area?.label.endsWith(city.name))?.name ?? '')
              : ''
          }
          onChange={(event) => area.chooseCity(event.target.value)}
        >
          <option value="">{copy.area.choose}</option>
          {area.cities.map((city) => (
            <option key={city.name} value={city.name}>
              {city.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {copy.cover.payoutChoice}
        <select
          disabled={locked}
          value={area.ratePerSecond.toString()}
          onChange={(event) => area.setRate(BigInt(event.target.value))}
          data-testid="rate"
        >
          {area.rates.map((rate) => (
            <option key={rate.toString()} value={rate.toString()}>
              {copy.cover.payoutOption(rate)}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">{copy.area.privacy}</p>
    </section>
  )
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

export function WhyThisPrice({ price }: { price: PriceView | null }) {
  if (!price) return null
  return (
    <details data-testid="why-price">
      <summary>{copy.price.show}</summary>
      <p>{copy.price.intro}</p>
      {price.why ? (
        <>
          <table>
            <tbody>
              {price.why.slots.map((slot) => (
                <tr key={slot.start}>
                  <td>{copy.price.slot(slot.start, slot.end)}</td>
                  <td>
                    {copy.price.chance(slot.probabilityWet)}
                    <br />
                    <span className="muted">{copy.price.basis[slot.basis]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>{copy.price.expected(price.why.expectedPayout)}</p>
          <p>{copy.price.load(price.why.loadBps)}</p>
        </>
      ) : (
        <p className="muted">{copy.price.unavailable}</p>
      )}
      <p>
        <strong>{copy.price.total(price.premium)}</strong>
      </p>
    </details>
  )
}

/** The switch, and every sentence about what cover is doing right now. */
export function CoverPanel() {
  const account = useAccount()
  const cover = useCover()
  const accrual = useAccrual()
  const weather = useWeather()
  const signedIn = account.status === 'signed_in'
  const raining = accrual.running && accrual.weather?.raining === true
  const price = cover.price

  let headline: string = cover.status === 'on' ? copy.cover.on : copy.cover.off
  if (cover.status === 'on' && cover.blocks.length === 0) headline = copy.cover.starting

  return (
    <section
      data-testid="cover"
      data-status={cover.status}
      data-activity={cover.activity}
      data-raining={String(raining)}
    >
      <h2>{copy.cover.heading}</h2>
      <p className="big" data-testid="cover-headline">
        {headline}
      </p>

      {weather.fresh === false ? (
        <p className="note warn" data-testid="weather-silent">
          {copy.weather.silent}
        </p>
      ) : null}

      {cover.status === 'on' && accrual.running ? (
        raining && accrual.ratePerSecond !== null ? (
          <p className="note good" data-testid="raining">
            {copy.cover.raining(accrual.ratePerSecond)}
          </p>
        ) : price ? (
          <p data-testid="dry">{copy.cover.dry(price.premium, price.seconds)}</p>
        ) : null
      ) : null}
      {cover.status === 'on' && !accrual.running && cover.blocks[0] ? (
        <p>{copy.cover.waitingToStart(cover.blocks[0].start)}</p>
      ) : null}
      {cover.coveredUntil ? <p className="muted">{copy.cover.coveredUntil(cover.coveredUntil)}</p> : null}
      {cover.status === 'on' ? <p className="muted">{copy.cover.renews}</p> : null}

      {cover.status === 'off' && price ? (
        <p data-testid="offer">{copy.cover.offer(price.premium, price.seconds, price.ratePerSecond)}</p>
      ) : null}
      {cover.status === 'off' ? <RefusalNote refusal={cover.priceRefusal} /> : null}

      {cover.stopped ? (
        <div className="note bad" role="alert" data-testid="cover-stopped" data-kind={cover.stopped.kind}>
          <p>{stopMessage(cover.stopped)}</p>
          {cover.stopped.kind === 'refused' && cover.stopped.refusal.capacity ? (
            <p className="muted">{copy.refusals.capacity(cover.stopped.refusal.capacity.available)}</p>
          ) : null}
        </div>
      ) : null}
      {cover.retrying ? <RefusalNote refusal={cover.retrying} /> : null}
      {cover.activity === 'confirming' ? <p className="warn">{copy.refusals.pending}</p> : null}
      {cover.gaps.map((gap) => (
        <p key={gap.from} className="muted">
          {copy.cover.gap(gap.from, gap.to)}
        </p>
      ))}

      <div className="row">
        {cover.status === 'on' ? (
          <button type="button" onClick={cover.turnOff} data-testid="turn-off">
            {copy.cover.turnOff}
          </button>
        ) : (
          <button type="button" disabled={!cover.canTurnOn} onClick={() => void cover.turnOn()} data-testid="turn-on">
            {copy.cover.turnOn}
          </button>
        )}
      </div>
      {!signedIn ? <p className="muted">{copy.account.intro}</p> : null}
      <p className="muted">{copy.cover.heavyRain}</p>
      <p className="muted">{copy.cover.noRefund}</p>
      <WhyThisPrice price={price} />
      {cover.blocks.length > 0 && cover.blocks.at(-1)?.transactionHash ? (
        <p className="muted">
          <RecordLink hash={cover.blocks.at(-1)!.transactionHash!} />
        </p>
      ) : null}
    </section>
  )
}

export function LockShiftPanel() {
  const lock = useLockShift()
  const cover = useCover()
  const account = useAccount()
  if (account.status !== 'signed_in' || !cover.area) return null
  return (
    <section data-testid="lock-shift" data-status={lock.status}>
      <h2>{copy.cover.lock.heading}</h2>
      <p>{copy.cover.lock.intro}</p>
      <label>
        {copy.cover.lock.length}
        <select value={lock.hours} onChange={(event) => lock.setHours(Number(event.target.value))}>
          {lock.hourOptions.map((hours) => (
            <option key={hours} value={hours}>
              {copy.cover.lock.hours(hours)}
            </option>
          ))}
        </select>
      </label>
      {lock.offer && lock.status !== 'done' ? (
        <div>
          <p>{copy.cover.lock.price(lock.offer.price.premium, lock.offer.price.start, lock.offer.price.end)}</p>
          <p className="muted">{copy.cover.lock.upTo(lock.offer.price.maxPayout)}</p>
          <p className="muted">
            {copy.cover.costs(lock.offer.price.premium, lock.offer.price.seconds)},{' '}
            {copy.cover.pays(lock.offer.price.ratePerSecond)}
          </p>
          {lock.needsConfirmation ? <p className="warn">{copy.account.confirm.cover_over_limit}</p> : null}
          <WhyThisPrice price={lock.offer.price} />
        </div>
      ) : null}
      {lock.status === 'done' && lock.bought ? (
        <p className="note good">
          {copy.cover.lock.locked(lock.bought.end)}{' '}
          {lock.bought.transactionHash ? <RecordLink hash={lock.bought.transactionHash} /> : null}
        </p>
      ) : null}
      <RefusalNote refusal={lock.refusal} />
      {lock.problem ? <p className="note bad">{lock.problem.title}</p> : null}
      <div className="row">
        <button
          type="button"
          className="secondary"
          disabled={lock.status === 'pricing' || lock.status === 'buying'}
          onClick={() => void lock.getPrice()}
        >
          {copy.cover.lock.getPrice}
        </button>
        <button type="button" disabled={!lock.offer || lock.status !== 'priced'} onClick={() => void lock.lock()}>
          {copy.cover.lock.confirm}
        </button>
      </div>
    </section>
  )
}

export function AccrualPanel() {
  const accrual = useAccrual()
  const account = useAccount()
  if (account.status !== 'signed_in') return null
  return (
    <section data-testid="accrual">
      <h2>{copy.accrual.heading}</h2>
      {accrual.shift ? (
        <>
          <dl>
            <dt>{copy.accrual.paid}</dt>
            <dd data-testid="paid" data-units={accrual.paid.toString()}>
              {formatDollars(accrual.paid)}
            </dd>
            <dt>{copy.accrual.confirmed}</dt>
            <dd data-testid="confirmed" data-units={accrual.confirmed.toString()}>
              {formatDollars(accrual.confirmed)}
            </dd>
            <dt>{copy.accrual.provisional}</dt>
            <dd data-testid="provisional" data-units={accrual.provisional.toString()}>
              {formatDollars(accrual.provisional)}
            </dd>
            <dt>{copy.accrual.cost}</dt>
            <dd>{formatDollars(accrual.cost)}</dd>
          </dl>
          {accrual.provisional > 0n ? <p className="muted">{copy.accrual.provisionalNote}</p> : null}
          {accrual.weather?.lastCheckedAt ? (
            <p className="muted">{copy.accrual.lastCheck(accrual.weather.lastCheckedAt, accrual.weather.raining)}</p>
          ) : (
            <p className="muted">{copy.accrual.noCheck}</p>
          )}
          {accrual.ratePerSecond !== null ? <p className="muted">{copy.cover.pays(accrual.ratePerSecond)}</p> : null}
          <p className="muted">{copy.history.row(accrual.shift.start, accrual.shift.end)}</p>
        </>
      ) : (
        <p>{copy.accrual.none}</p>
      )}
    </section>
  )
}
