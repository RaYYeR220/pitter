'use client'

import { COVER_DEFAULTS, SESSION_DEFAULTS } from '@/lib/config'
import { copy } from '@/lib/copy'
import { formatCountdown, formatDollars, perMinute } from '@/lib/format'
import { useAccount, useSessionClock } from '@/hooks/account'
import { Figure } from './ui/figure'
import { Hairline } from './ui/hairline'
import { Banner, Sheet } from './ui/notice'
import { ProblemNote } from './notes'

function SignInButtons({ busy }: { busy: boolean }) {
  const account = useAccount()
  return (
    <div className="actions">
      {account.returning ? (
        <>
          <button
            type="button"
            className="btn btn--ink btn--wide"
            disabled={busy}
            onClick={() => account.signIn()}
            data-testid="sign-in"
          >
            {copy.account.signIn}
          </button>
          <button type="button" className="btn btn--line btn--wide" disabled={busy} onClick={() => account.signIn(true)}>
            {copy.account.signInAny}
          </button>
          <button type="button" className="link" disabled={busy} onClick={() => account.signUp()} data-testid="sign-up">
            {copy.account.start}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="btn btn--ink btn--wide"
            disabled={busy}
            onClick={() => account.signUp()}
            data-testid="sign-up"
          >
            {copy.account.start}
          </button>
          <button
            type="button"
            className="btn btn--line btn--wide"
            disabled={busy}
            onClick={() => account.signIn(true)}
            data-testid="sign-in"
          >
            {copy.account.haveAccount}
          </button>
        </>
      )}
    </div>
  )
}

/**
 * Signing up, signing in, the sign-in's countdown and why it ended.
 *
 * Signed out, on the cover screen it is the whole first screen (`gate`); on the pool it is a slip. Signed in,
 * it is the session strip: how long the sign-in has left, what it may do without asking, and what always asks.
 */
export function AccountPanel({ variant = 'gate' }: { variant?: 'gate' | 'slip' }) {
  const account = useAccount()
  const clock = useSessionClock()
  const busy = account.status === 'signing_up' || account.status === 'signing_in' || account.renewing

  if (account.status !== 'signed_in') {
    const ended = account.ended
    const status = (
      <>
        {ended ? (
          <Banner tone="wait" testId="session-ended" data={{ 'data-reason': ended }}>
            <p>{copy.account.ended[ended]}</p>
          </Banner>
        ) : null}
        <ProblemNote problem={account.problem} />
        {busy ? (
          <p className="mono waiting" aria-live="polite">
            {copy.account.waiting}
          </p>
        ) : null}
      </>
    )
    const scope = (
      <p className="mono scope-note">
        {copy.account.scope(SESSION_DEFAULTS.maxSpendPerHour, SESSION_DEFAULTS.lengthMs / 1000)}
      </p>
    )

    if (variant === 'slip') {
      return (
        <Sheet
          as="section"
          className="gate-slip"
          labelledBy="account-h"
          testId="account"
          data={{ 'data-status': account.status }}
        >
          <h2 className="h-block" id="account-h">
            {copy.account.heading}
          </h2>
          <p className="small">{copy.account.intro}</p>
          {status}
          <SignInButtons busy={busy} />
          {scope}
        </Sheet>
      )
    }

    return (
      <section className="screen gate" aria-labelledby="account-h" data-testid="account" data-status={account.status}>
        <div className="screen__lead">
          <h1 className="sentence" id="account-h">
            {ended ? copy.screen.gate.ended[ended] : copy.account.heading}
          </h1>
          {ended ? (
            <Figure value={formatCountdown(0)} wipe label={copy.screen.gate.endedLabel} />
          ) : (
            <Figure value={formatDollars(perMinute(COVER_DEFAULTS.defaultRate))} wipe />
          )}
          <p className="figcap">{ended ? copy.screen.gate.endedCaption : copy.screen.gate.caption}</p>
          {ended ? (
            <Hairline mode="broken" left={copy.screen.gate.endedLeft} right={copy.screen.gate.endedRight} />
          ) : (
            <Hairline progress={1} marks={10} left={copy.screen.hair.line} />
          )}
        </div>
        <div className="screen__side">
          <p className="gate__intro">{copy.account.intro}</p>
          {status}
          <SignInButtons busy={busy} />
          {scope}
        </div>
      </section>
    )
  }

  const soonest = clock ? Math.min(clock.remainingMs, clock.idleRemainingMs ?? Infinity) : 0
  return (
    <section className="session" data-testid="account" data-status="signed_in" aria-label={copy.screen.session.label}>
      <div className="session__in">
        {clock ? (
          <div className={`session__clock${clock.expiring ? ' session__clock--ending' : ''}`} data-testid="session-clock">
            <p className="session__time">
              <i className="session__dot" aria-hidden="true" />
              {clock.expiring ? copy.session.expiring(soonest) : copy.session.remaining(clock.remainingMs)}
            </p>
            <div className="session__meter">
              <Hairline className="session__hair" progress={clock.remainingMs / SESSION_DEFAULTS.lengthMs} />
              <p className="mono session__meta">
                <span>{copy.session.spend(clock.spentThisHour, clock.maxSpendPerHour)}</span>
                {clock.idleRemainingMs !== null && !clock.expiring ? (
                  <span>{copy.session.idle(clock.idleRemainingMs)}</span>
                ) : null}
              </p>
            </div>
          </div>
        ) : null}
        <p className="mono session__scope">
          {copy.screen.session.scope(clock?.maxSpendPerHour ?? SESSION_DEFAULTS.maxSpendPerHour)}
        </p>
        <div className="session__actions">
          {clock?.expiring ? (
            <button type="button" className="btn btn--ink" disabled={busy} onClick={() => account.signIn()}>
              {copy.session.renew}
            </button>
          ) : null}
          <button type="button" className="btn btn--quiet" onClick={account.signOut} data-testid="sign-out">
            {copy.account.signOut}
          </button>
        </div>
      </div>
      <ProblemNote problem={account.problem} />
      {account.confirming ? (
        <Banner tone="wait" live className="session__confirm">
          <p>{copy.account.confirm[account.confirming]}</p>
        </Banner>
      ) : null}
    </section>
  )
}
