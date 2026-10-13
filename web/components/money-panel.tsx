'use client'

import { useState } from 'react'
import { copy } from '@/lib/copy'
import { groupShifts } from '@/lib/cover/accrual'
import { phaseOf } from '@/lib/cover/history'
import { formatDayAndClock, formatDollars } from '@/lib/format'
import { useAccount } from '@/hooks/account'
import { useBalance, useCoverHistory } from '@/hooks/cover'
import { useCashOut, usePractice } from '@/hooks/money'
import { useNow, useRuntime } from '@/hooks/runtime'
import { ProblemNote, RecordLink, RefusalNote } from './notes'

const CASH_OUT_PROBLEMS = {
  invalid_to: copy.money.invalidTo,
  same_account: copy.money.sameAccount,
  invalid_amount: copy.money.invalidAmount,
  too_much: copy.money.tooMuch,
} as const

export function MoneyPanel() {
  const account = useAccount()
  const balance = useBalance()
  const cashOut = useCashOut()
  const { config } = useRuntime()
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  if (account.status !== 'signed_in') return null

  return (
    <section data-testid="money">
      <h2>{copy.money.balance}</h2>
      {balance.data ? (
        <p className="big" data-testid="balance" data-units={balance.data.dollars.toString()}>
          {formatDollars(balance.data.dollars)}
        </p>
      ) : balance.error ? (
        <p className="warn">{copy.money.balanceUnknown}</p>
      ) : (
        <p>{copy.status.loading}</p>
      )}

      <h3>{copy.money.add}</h3>
      <p>{config.practice ? copy.money.addPractice : copy.money.addLive}</p>
      <p className="muted">
        {copy.account.accountNumber}: <code>{account.address}</code>
      </p>

      <details data-testid="cash-out">
        <summary>{copy.money.cashOut}</summary>
        <p>{copy.money.cashOutIntro}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void cashOut.submit({ to, amount })
          }}
        >
          <label>
            {copy.money.to}
            <input value={to} onChange={(event) => setTo(event.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <label>
            {copy.money.amount}
            <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" />
          </label>
          <div className="row">
            <button
              type="button"
              className="secondary"
              onClick={() => balance.data && setAmount(formatDollars(balance.data.dollars).replace(/[$,]/g, ''))}
            >
              {copy.money.all}
            </button>
            <button type="submit" disabled={cashOut.status === 'confirming' || cashOut.status === 'sending'}>
              {copy.money.cashOut}
            </button>
          </div>
        </form>
        {cashOut.inputProblem ? <p className="note warn">{CASH_OUT_PROBLEMS[cashOut.inputProblem]}</p> : null}
        {cashOut.status === 'confirming' ? <p>{copy.account.confirm.cash_out}</p> : null}
        {cashOut.status === 'sending' ? <p>{copy.status.working}</p> : null}
        <ProblemNote problem={cashOut.problem} />
        {cashOut.refusal ? (
          <>
            <p className="note bad">{cashOut.refusal.outcomeUnknown ? copy.money.pending : copy.money.failed}</p>
            <RefusalNote refusal={cashOut.refusal} />
          </>
        ) : null}
        {cashOut.receipt ? (
          <p className="note good">
            {copy.money.done(cashOut.receipt.value)} <RecordLink hash={cashOut.receipt.transactionHash} />
          </p>
        ) : null}
      </details>
    </section>
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
    <section data-testid="history" data-count={records.length}>
      <h2>{copy.history.heading}</h2>
      {history.error && !history.data ? <p className="warn">{copy.history.unavailable}</p> : null}
      {history.data && records.length === 0 ? <p>{copy.history.empty}</p> : null}
      {records.length > 0 ? <p data-testid="history-totals">{copy.history.totals(cost, paid)}</p> : null}
      {shifts.map((shift) => (
        <div key={shift.start}>
          <h3>{formatDayAndClock(shift.start)}</h3>
          <ul className="plain">
            {shift.records.map((record) => (
              <li key={record.id.toString()} data-testid="history-row" data-id={record.id.toString()}>
                {copy.history.row(record.start, record.end)} · {copy.history.status[phaseOf(record, now)]}
                <br />
                <span className="muted">
                  {copy.history.cost(record.premium)}
                  {record.paid > 0n ? ` · ${copy.history.paid(record.paid)}` : ''}
                </span>{' '}
                {record.purchase ? <RecordLink hash={record.purchase} /> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}

/** Practice-mode tools. Rendered only when the server says this is practice mode. */
export function PracticePanel() {
  const practice = usePractice()
  const account = useAccount()
  if (!practice.available) return null
  const wet = practice.rain.data?.wet ?? false
  const check = practice.check.result

  return (
    <section data-testid="practice">
      <h2>{copy.practice.heading}</h2>
      <p className="note warn">{copy.practice.label}</p>

      <div className="row">
        <button
          type="button"
          className="secondary"
          disabled={account.status !== 'signed_in' || practice.money.status === 'working'}
          onClick={() => void practice.getMoney()}
          data-testid="practice-money"
        >
          {copy.practice.money}
        </button>
      </div>
      {practice.money.status === 'done' ? (
        <p className="good" data-testid="practice-money-done">
          {copy.practice.moneyDone(practice.money.amount)}
        </p>
      ) : null}
      {practice.money.status === 'failed' ? (
        <p className="warn">{practice.money.limited ? copy.practice.moneyLimited : copy.practice.moneyFailed}</p>
      ) : null}

      <label className="row">
        <input
          type="checkbox"
          style={{ width: 24, minHeight: 24 }}
          checked={wet}
          disabled={practice.rainStatus === 'working' || practice.rain.data === null}
          onChange={(event) => void practice.setRain(event.target.checked)}
          data-testid="make-it-rain"
        />
        {copy.practice.rain}
      </label>
      <p data-testid="rain-state" data-wet={String(wet)}>
        {wet ? copy.practice.rainOn : copy.practice.rainOff}
      </p>
      <p className="muted">{copy.practice.rainNote}</p>

      <button
        type="button"
        className="secondary"
        disabled={practice.check.status === 'working'}
        onClick={() => void practice.checkWeather()}
        data-testid="weather-check"
      >
        {practice.check.status === 'working' ? copy.practice.checking : copy.practice.check}
      </button>
      {practice.check.status === 'done' && check ? (
        <p data-testid="weather-check-done" data-payouts={check.settlement.settled.filter((entry) => entry.paid > 0n).length}>
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
      {practice.check.status === 'failed' ? <p className="warn">{copy.practice.checkFailed}</p> : null}
    </section>
  )
}
