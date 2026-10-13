'use client'

import { useState } from 'react'
import type { AccountProblem } from '@/lib/account'
import { transactionUrl } from '@/lib/config'
import { copy } from '@/lib/copy'
import type { Refusal } from '@/lib/cover/refusals'
import { formatDollars } from '@/lib/format'
import { useRuntime } from '@/hooks/runtime'
import { Banner } from './ui/notice'

export function RefusalNote({ refusal }: { refusal: Refusal | null }) {
  if (!refusal) return null
  return (
    <Banner
      tone={refusal.kind === 'pending' ? 'wait' : 'stop'}
      alert
      testId="refusal"
      data={{ 'data-kind': refusal.kind }}
    >
      <p>{refusal.message}</p>
      {refusal.capacity && refusal.capacity.available > 0n ? (
        <p className="mono">{copy.refusals.capacity(refusal.capacity.available)}</p>
      ) : null}
      {refusal.transactionHash ? (
        <p className="mono">
          <RecordLink hash={refusal.transactionHash} />
        </p>
      ) : null}
    </Banner>
  )
}

export function ProblemNote({ problem }: { problem: AccountProblem | null }) {
  const [showAddress, setShowAddress] = useState(false)
  if (!problem) return null
  return (
    <Banner tone="stop" alert testId="account-problem" data={{ 'data-code': problem.code }}>
      <p>
        <strong>{problem.title}</strong>
      </p>
      {problem.guidance.map((line) => (
        <p key={line} className="small">
          {line}
        </p>
      ))}
      {problem.suggestPhone ? (
        <div>
          <button type="button" className="btn btn--line" onClick={() => setShowAddress(true)}>
            {copy.account.openOnPhone}
          </button>
          {showAddress ? (
            <p className="small">
              {copy.account.openOnPhoneHint} <code className="address">{globalThis.location?.href}</code>
            </p>
          ) : null}
        </div>
      ) : null}
    </Banner>
  )
}

/** Link to the public record of a transaction. */
export function RecordLink({ hash }: { hash: string }) {
  const { config } = useRuntime()
  return (
    <a
      className="record"
      href={transactionUrl(config, hash)}
      target="_blank"
      rel="noreferrer"
      data-testid="record-link"
    >
      {copy.status.publicRecord}
    </a>
  )
}

export function Dollars({ units, sign = false }: { units: bigint; sign?: boolean }) {
  return <span>{formatDollars(units, { sign })}</span>
}
