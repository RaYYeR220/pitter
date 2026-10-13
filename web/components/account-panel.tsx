'use client'

import { SESSION_DEFAULTS } from '@/lib/config'
import { copy } from '@/lib/copy'
import { shortAccount } from '@/lib/format'
import { useAccount, useSessionClock } from '@/hooks/account'
import { ProblemNote } from './notes'

/** Signing up, signing in, the sign-in's countdown and why it ended. */
export function AccountPanel() {
  const account = useAccount()
  const clock = useSessionClock()
  const busy = account.status === 'signing_up' || account.status === 'signing_in' || account.renewing

  if (account.status !== 'signed_in') {
    return (
      <section data-testid="account" data-status={account.status}>
        <h2>{copy.account.heading}</h2>
        {account.ended ? (
          <p className="note warn" data-testid="session-ended" data-reason={account.ended}>
            {copy.account.ended[account.ended]}
          </p>
        ) : (
          <p>{copy.account.intro}</p>
        )}
        <ProblemNote problem={account.problem} />
        {busy ? <p aria-live="polite">{copy.account.waiting}</p> : null}
        <div className="row">
          {account.returning ? (
            <>
              <button type="button" disabled={busy} onClick={() => account.signIn()} data-testid="sign-in">
                {copy.account.signIn}
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => account.signIn(true)}>
                {copy.account.signInAny}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => account.signUp()}
                data-testid="sign-up"
              >
                {copy.account.start}
              </button>
            </>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={() => account.signUp()} data-testid="sign-up">
                {copy.account.start}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => account.signIn(true)}
                data-testid="sign-in"
              >
                {copy.account.haveAccount}
              </button>
            </>
          )}
        </div>
        <p className="muted">
          {copy.account.scope(SESSION_DEFAULTS.maxSpendPerHour, SESSION_DEFAULTS.lengthMs / 1000)}
        </p>
      </section>
    )
  }

  return (
    <section data-testid="account" data-status="signed_in">
      <dl>
        <dt>{copy.account.accountNumber}</dt>
        <dd>
          <code data-testid="account-number" title={account.address ?? ''} data-address={account.address ?? ''}>
            {shortAccount(account.address ?? '')}
          </code>
        </dd>
      </dl>
      {clock ? (
        <div data-testid="session-clock">
          <p className={clock.expiring ? 'warn' : 'muted'}>
            {clock.expiring
              ? copy.session.expiring(Math.min(clock.remainingMs, clock.idleRemainingMs ?? Infinity))
              : copy.session.remaining(clock.remainingMs)}
          </p>
          {clock.idleRemainingMs !== null && !clock.expiring ? (
            <p className="muted">{copy.session.idle(clock.idleRemainingMs)}</p>
          ) : null}
          <p className="muted">{copy.session.spend(clock.spentThisHour, clock.maxSpendPerHour)}</p>
        </div>
      ) : null}
      <ProblemNote problem={account.problem} />
      {account.confirming ? <p aria-live="polite">{copy.account.confirm[account.confirming]}</p> : null}
      <div className="row">
        {clock?.expiring ? (
          <button type="button" disabled={busy} onClick={() => account.signIn()}>
            {copy.session.renew}
          </button>
        ) : null}
        <button type="button" className="secondary" onClick={account.signOut} data-testid="sign-out">
          {copy.account.signOut}
        </button>
      </div>
    </section>
  )
}
