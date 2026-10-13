import Link from 'next/link'
import type { CSSProperties } from 'react'
import { COVER_DEFAULTS, SESSION_DEFAULTS } from '@/lib/config'
import { copy } from '@/lib/copy'
import { formatDollars } from '@/lib/format'
import { Meter, MeterCaps } from '../ui/meter'
import { Rain } from '../ui/rain'
import { SwitchLink } from '../ui/switch'
import { ExampleChart } from './example-chart'
import { EXAMPLE, POOL_EXAMPLE, formatExact } from './example'
import { HeroMeter } from './hero-meter'
import { PracticeOnly, ScrollTo } from './islands'

/** The marketing page: one claim and one button above the fold, then how a shift goes, worked through. */
export function Landing() {
  const story = copy.story
  const rates = COVER_DEFAULTS.rates
  const worked = story.worked
  return (
    <div className="landing">
      <section className="hero" aria-labelledby="claim">
        <div className="hero__main">
          <Rain className="hero__rain" />
          <HeroMeter ratePerSecond={EXAMPLE.ratePerSecond} startSeconds={9 * 60} />
          <h1 className="hero__claim enter" id="claim" style={{ '--i': 1 } as CSSProperties}>
            {copy.landing.claim}
          </h1>
          <p className="hero__support enter" style={{ '--i': 2 } as CSSProperties}>
            {copy.landing.support}
          </p>
          <div className="hero__cta enter" style={{ '--i': 3 } as CSSProperties}>
            <SwitchLink href="/app" testId="landing-cta">
              {copy.landing.button}
            </SwitchLink>
          </div>
        </div>
        <p className="hero__fine mono">{story.fine}</p>
      </section>

      <section className="lsec" id="how" aria-labelledby="how-h">
        <h2 className="h-display" id="how-h">
          {story.how.heading}
        </h2>
        <p className="lede lsec__lede">{story.how.lede}</p>
        <ol className="moves">
          {story.how.moves(rates).map((move) => (
            <li key={move.verb} className={move.rain ? 'moves__item moves__item--rain' : 'moves__item'}>
              <p className="moves__when mono">
                <b>{move.time}</b>
                {move.label}
              </p>
              <h3 className="moves__verb">{move.verb}</h3>
              <p className="moves__text">{move.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="lsec" id="example" aria-labelledby="example-h">
        <h2 className="h-display" id="example-h">
          {worked.heading}
        </h2>
        <p className="lede lsec__lede">{worked.lede(formatDollars(EXAMPLE.ratePerMinute))}</p>
        <ScrollTo x={580} label={worked.chartLabel}>
          <ExampleChart />
        </ScrollTo>
        <p className="plot__hint mono">{worked.hint}</p>
        <div className="lsplit">
          <div className="prose">
            {worked
              .story({
                floorChance: EXAMPLE.floorChance,
                dryPerMinute: formatExact(EXAMPLE.dryPerMinute),
                blockCost: formatExact(EXAMPLE.blockCost),
                blockMinutes: EXAMPLE.blockMinutes,
                eveningChance: EXAMPLE.eveningChance,
                locked: formatExact(EXAMPLE.locked),
                stormBlock: formatExact(EXAMPLE.stormBlock),
                wetMinutes: EXAMPLE.wetMinutes,
                cost: formatExact(EXAMPLE.cost),
              })
              .map((paragraph) => (
                <p key={paragraph.slice(0, 24)}>{paragraph}</p>
              ))}
          </div>
          <dl className="ledger" aria-label={worked.receiptLabel}>
            {[
              {
                when: worked.rows.payWhen,
                what: worked.rows.pay(EXAMPLE.payBlocks, EXAMPLE.blockMinutes, formatExact(EXAMPLE.dryPerMinute)),
                amount: formatExact(-EXAMPLE.payAsYouGo),
              },
              { when: worked.rows.lockWhen, what: worked.rows.lock, amount: formatExact(-EXAMPLE.locked) },
              {
                when: worked.rows.rainWhen,
                what: worked.rows.rain(EXAMPLE.wetMinutes, formatDollars(EXAMPLE.ratePerMinute)),
                amount: formatExact(EXAMPLE.paid, { sign: true }),
                rain: true,
              },
            ].map((row) => (
              <div key={row.when} className={row.rain ? 'ledger__row ledger__row--rain' : 'ledger__row'}>
                <dt>
                  <span className="mono">{row.when}</span>
                  {row.what}
                </dt>
                <dd>{row.amount}</dd>
              </div>
            ))}
            <div className="ledger__row ledger__row--total">
              <dt>{worked.rows.total}</dt>
              <dd>{formatExact(EXAMPLE.ahead, { sign: true })}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="lsec" id="pool" aria-labelledby="pool-h">
        <h2 className="h-display" id="pool-h">
          {story.pool.heading}
        </h2>
        <div className="lsplit">
          <div className="prose">
            {story.pool.paragraphs.map((paragraph) => (
              <p key={paragraph.slice(0, 24)}>{paragraph}</p>
            ))}
            <p>
              <Link className="btn btn--line" href="/pool">
                {story.pool.button}
              </Link>
            </p>
          </div>
          <figure className="limit">
            <figcaption className="mono">{story.pool.figureCaption}</figcaption>
            <p className="limit__big">{formatDollars(POOL_EXAMPLE.left)}</p>
            <p className="limit__cap">{story.pool.figureLine(formatDollars(POOL_EXAMPLE.needed))}</p>
            <Meter
              share={POOL_EXAMPLE.share}
              size="lg"
              overflow
              label={story.pool.meterLabel(formatDollars(POOL_EXAMPLE.used), formatDollars(POOL_EXAMPLE.limit))}
            />
            <MeterCaps>
              <span>
                <b>{formatDollars(POOL_EXAMPLE.used)}</b>
                {story.pool.used}
              </span>
              <span>
                <b>{formatDollars(POOL_EXAMPLE.limit)}</b>
                {story.pool.limit}
              </span>
            </MeterCaps>
          </figure>
        </div>
      </section>

      <section className="lsec" id="limits" aria-labelledby="limits-h">
        <h2 className="h-display" id="limits-h">
          {story.nots.heading}
        </h2>
        <ul className="nots">
          {story.nots.items.map((item) => (
            <li key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="lsec lsec--faq" id="questions" aria-labelledby="questions-h">
        <h2 className="h-display" id="questions-h">
          {story.questions.heading}
        </h2>
        <div className="faq">
          {story.questions
            .items(rates, SESSION_DEFAULTS.maxSpendPerHour, SESSION_DEFAULTS.lengthMs / 1000)
            .map((item, index) => (
              <details key={item.q} className="disclose faq__item" open={index === 0}>
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          <PracticeOnly>
            <details className="disclose faq__item">
              <summary>{story.questions.practice.q}</summary>
              <p>{story.questions.practice.a}</p>
            </details>
          </PracticeOnly>
        </div>
      </section>

      <section className="lsec lsec--close" aria-labelledby="close-h">
        <h2 className="h-display" id="close-h">
          {story.close.heading}
        </h2>
        <p className="lede">{story.close.lede}</p>
        <div className="close__cta">
          <SwitchLink href="/app">{copy.landing.button}</SwitchLink>
        </div>
        <PracticeOnly>
          <p className="mono close__fine">{copy.landing.practice}</p>
        </PracticeOnly>
        <p className="mono close__fine">{story.close.examples}</p>
      </section>

      <p className="wordmark" aria-hidden="true">
        {copy.product.name}
      </p>
    </div>
  )
}
