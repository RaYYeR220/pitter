'use client'

import { useState } from 'react'
import type { AccountProblem } from '@/lib/account'
import { transactionUrl } from '@/lib/config'
import { copy } from '@/lib/copy'
import type { Refusal } from '@/lib/cover/refusals'
import { formatDollars } from '@/lib/format'
import { useRuntime } from '@/hooks/runtime'

export function RefusalNote({ refusal }: { refusal: Refusal | null }) {
  if (!refusal) return null
  const tone = refusal.kind === 'pending' ? 'warn' : 'bad'
  return (
    <div className={`note ${tone}`} role="alert" data-testid="refusal" data-kind={refusal.kind}>
      <p>{refusal.message}</p>
      {refusal.capacity && refusal.capacity.available > 0n ? (
        <p className="muted">{copy.refusals.capacity(refusal.capacity.available)}</p>
      ) : null}
      {refusal.transactionHash ? <RecordLink hash={refusal.transactionHash} /> : null}
    </div>
  )
}

export function ProblemNote({ problem }: { problem: AccountProblem | null }) {
  const [showAddress, setShowAddress] = useState(false)
  if (!problem) return null
  return (
    <div className="note bad" role="alert" data-testid="account-problem" data-code={problem.code}>
      <p>
        <strong>{problem.title}</strong>
      </p>
      {problem.guidance.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {problem.suggestPhone ? (
        <div>
          <button type="button" className="secondary" onClick={() => setShowAddress(true)}>
            {copy.account.openOnPhone}
          </button>
          {showAddress ? (
            <p>
              {copy.account.openOnPhoneHint} <code>{globalThis.location?.href}</code>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Link to the public record of a transaction. */
export function RecordLink({ hash }: { hash: string }) {
  const { config } = useRuntime()
  return (
    <a href={transactionUrl(config, hash)} target="_blank" rel="noreferrer" data-testid="record-link">
      {copy.status.publicRecord}
    </a>
  )
}

export function Dollars({ units, sign = false }: { units: bigint; sign?: boolean }) {
  return <span>{formatDollars(units, { sign })}</span>
}
