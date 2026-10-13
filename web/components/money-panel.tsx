'use client'

import { useState } from 'react'
import { copy } from '@/lib/copy'
import { groupShifts } from '@/lib/cover/accrual'
import { phaseOf } from '@/lib/cover/history'
import { formatDayAndClock, formatDollars, shortAccount } from '@/lib/format'
import { useAccount } from '@/hooks/account'
import { useBalance, useCoverHistory } from '@/hooks/cover'
import { useCashOut, usePractice } from '@/hooks/money'
import { useNow, useRuntime } from '@/hooks/runtime'
import { ProblemNote, RecordLink, RefusalNote } from './notes'
import { Figure } from './ui/figure'
import { AsksAgain, Banner, Block } from './ui/notice'
import { Receipt, Receipts } from './ui/receipt'

const CASH_OUT_PROBLEMS = {
  invalid_to: copy.money.invalidTo,
  same_account: copy.money.sameAccount,
  invalid_amount: copy.money.invalidAmount,
  too_much: copy.money.tooMuch,
} as const

/** The account number, with a button that copies it. */
function AccountNumber({ address }: { address: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="accno">
      <p className="accno__label small">{copy.account.accountNumber}</p>
      <p className="accno__row">
        <code className="address" data-testid="account-number" title={address} data-address={address}>
          {shortAccount(address)}
        </code>
        <button
          type="button"
          className="btn btn--quiet"
          onClick={() => {
            void navigator.clipboard?.writeText(address).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }}
        >
          {copied ? copy.status.copied : copy.status.copy}
        </button>
      </p>
    </div>
  )
}

export function MoneyPanel() {
  const account = useAccount()
  const balance = useBalance()
  const cashOut = useCashOut()
  const { config } = useRuntime()
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  if (account.status !== 'signed_in') return null
  const busy = cashOut.status === 'confirming' || cashOut.status === 'sending'

  return (
    <Block id="money" title={copy.money.balance} testId="money">
      {balance.data ? (
        <Figure value={formatDollars(balance.data.dollars)} size="slip" />
      ) : (
        <p className="mono">{balance.error ? copy.money.balanceUnknown : copy.status.loading}</p>
      )}

      <div className="money__add">
        <h3 className="h-sub">{copy.money.add}</h3>
        <p className="small">{config.practice ? copy.money.addPractice : copy.money.addLive}</p>
        {account.address ? <AccountNumber address={account.address} /> : null}
      </div>

      <details className="disclose cashout" data-testid="cash-out">
        <summary>
          <span className="cashout__title">{copy.money.cashOut}</span>
          <span className="mono cashout__asks">{copy.screen.money.asks}</span>
        </summary>
        <form
          className="sheet-slip cashout__form"
          onSubmit={(event) => {
            event.preventDefault()
            void cashOut.submit({ to, amount })
          }}
        >
          <p className="small">{copy.money.cashOutIntro}</p>
          <label className="field">
            <span>{copy.money.to}</span>
            <input
              className="input"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="0x…"
            />
          </label>
          <label className="field">
            <span>{copy.money.amount}</span>
            <span className="money-input">
              <input
                className="input input--money"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                inputMode="decimal"
              />
              <button
                type="button"
                className="btn btn--quiet"
                onClick={() => balance.data && setAmount(formatDollars(balance.data.dollars).replace(/[$,]/g, ''))}
              >
                {copy.money.all}
              </button>
            </span>
          </label>
          <div className="actions">
            <button
              type="submit"
              className="btn btn--ink btn--wide"
              disabled={busy}
              aria-describedby="cashout-asks"
            >
              {cashOut.status === 'sending' ? copy.status.working : copy.money.cashOut}
            </button>
            <AsksAgain id="cashout-asks">{copy.screen.money.asksLong}</AsksAgain>
          </div>
          {cashOut.inputProblem ? (
            <Banner tone="stop" alert>
              <p>{CASH_OUT_PROBLEMS[cashOut.inputProblem]}</p>
            </Banner>
          ) : null}
          {cashOut.status === 'confirming' ? (
            <Banner tone="wait" live>
              <p>{copy.account.confirm.cash_out}</p>
            </Banner>
          ) : null}
          <ProblemNote problem={cashOut.problem} />
          {cashOut.refusal ? (
            <>
              <Banner tone="stop" alert>
                <p>{cashOut.refusal.outcomeUnknown ? copy.money.pending : copy.money.failed}</p>
              </Banner>
              <RefusalNote refusal={cashOut.refusal} />
            </>
          ) : null}
          {cashOut.receipt ? (
            <Banner tone="done" live>
              <p>
                {copy.money.done(cashOut.receipt.value)} <RecordLink hash={cashOut.receipt.transactionHash} />
              </p>
            </Banner>
          ) : null}
        </form>
      </details>
    </Block>
  )
}

export function HistoryPanel() {
  const account = useAccount()
  const history = useCoverHistory()
  const now = Math.floor(useNow(5000) / 1000)
  if (account.status !== 'signed_in') return null
  const records = history.data?.records ?? []
  const shifts = groupShifts(records)
  const cost = records.reduce((sum, record) => sum + record.premium, 0n)
  const paid = records.reduce((sum, record) => sum + record.paid, 0n)

  return (
    <Block id="history" title={copy.history.heading} testId="history" data={{ 'data-count': String(records.length) }}>
      {history.error && !history.data ? <p className="mono">{copy.history.unavailable}</p> : null}
      {!history.data && !history.error ? <p className="mono">{copy.status.loading}</p> : null}
      {history.data && records.length === 0 ? <p className="small dim">{copy.history.empty}</p> : null}
      {records.length > 0 ? (
        <p className="history__totals" data-testid="history-totals">
          {copy.history.totals(cost, paid)}
        </p>
      ) : null}
      {shifts.map((shift) => (
        <div key={shift.start} className="shiftgroup">
          <h3 className="mono shiftgroup__day">{formatDayAndClock(shift.start)}</h3>
          <Receipts>
            {shift.records.map((record) => (
              <Receipt
                key={record.id.toString()}
                testId="history-row"
                data={{
                  'data-id': record.id.toString(),
                  'data-start': String(record.start),
                  'data-paid': record.paid.toString(),
                }}
                rain={record.paid > 0n}
                what={copy.history.row(record.start, record.end)}
                when={copy.history.status[phaseOf(record, now)]}
                amount={record.paid > 0n ? formatDollars(record.paid, { sign: true }) : formatDollars(-record.premium)}
                paid={record.paid > 0n ? copy.screen.history.paidAgainst(record.premium) : copy.history.cost(record.premium)}
                record={record.purchase ? <RecordLink hash={record.purchase} /> : null}
              />
            ))}
          </Receipts>
        </div>
      ))}
    </Block>
  )
}

/** Practice-mode tools. Rendered only when the server says this is practice mode. */
export function PracticePanel() {
  const practice = usePractice()
  const account = useAccount()
  if (!practice.available) return null
  const wet = practice.rain.data?.wet ?? false
  const check = practice.check.result
  const signedIn = account.status === 'signed_in'

  return (
    <section className="sim" data-testid="practice" aria-labelledby="sim-h">
      <div className="sim__head">
        <h2 className="sim__title" id="sim-h">
          {copy.practice.heading}
        </h2>
        <p className="mono">{copy.practice.label}</p>
      </div>
      <div className="sim__grid">
        <div className="sim__cell">
          <p className="sim__step mono">{copy.screen.sim.money}</p>
          <button
            type="button"
            className="btn btn--sim"
            disabled={!signedIn || practice.money.status === 'working'}
            onClick={() => void practice.getMoney()}
            data-testid="practice-money"
          >
            {practice.money.status === 'working' ? copy.status.working : copy.practice.money}
          </button>
          {!signedIn ? <p className="mono">{copy.screen.sim.signIn}</p> : null}
          {practice.money.status === 'done' ? (
            <p className="mono sim__done" data-testid="practice-money-done">
              {copy.practice.moneyDone(practice.money.amount)}
            </p>
          ) : null}
          {practice.money.status === 'failed' ? (
            <p className="mono">{practice.money.limited ? copy.practice.moneyLimited : copy.practice.moneyFailed}</p>
          ) : null}
        </div>

        <div className="sim__cell">
          <p className="sim__step mono">{copy.screen.sim.rain}</p>
          <label className="minisw">
            <input
              type="checkbox"
              role="switch"
              className="minisw__input"
              checked={wet}
              disabled={practice.rainStatus === 'working' || practice.rain.data === null}
              onChange={(event) => void practice.setRain(event.target.checked)}
              data-testid="make-it-rain"
            />
            <span>{copy.practice.rain}</span>
          </label>
          <p className="small" data-testid="rain-state" data-wet={String(wet)}>
            {wet ? copy.practice.rainOn : copy.practice.rainOff}
          </p>
          <p className="mono">{copy.practice.rainNote}</p>
        </div>

        <div className="sim__cell">
          <p className="sim__step mono">{copy.screen.sim.check}</p>
          <button
            type="button"
            className="btn btn--sim"
            disabled={practice.check.status === 'working'}
            onClick={() => void practice.checkWeather()}
            data-testid="weather-check"
          >
            {practice.check.status === 'working' ? copy.practice.checking : copy.practice.check}
          </button>
          {practice.check.status === 'done' && check ? (
            <p
              className="mono sim__done"
              data-testid="weather-check-done"
              data-payouts={check.settlement.settled.filter((entry) => entry.paid > 0n).length}
            >
              {check.report.readings.length === 0 && check.settlement.settled.length === 0
                ? copy.practice.checkedNothing
                : copy.practice.checked(
                    check.report.readings.length,
                    check.settlement.settled.filter((entry) => entry.paid > 0n).length,
                  )}{' '}
              {[...check.report.transactions, ...check.settlement.transactions].map((hash) => (
                <span key={hash}>
                  <RecordLink hash={hash} />{' '}
                </span>
              ))}
            </p>
          ) : null}
          {practice.check.status === 'failed' ? <p className="mono">{copy.practice.checkFailed}</p> : null}
        </div>
      </div>
    </section>
  )
}
