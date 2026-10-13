import type { ReactNode } from 'react'

/** A list of receipts: what happened, when, how much, and the public record of it. */
export function Receipts({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <ol className={`receipts${className ? ` ${className}` : ''}`} aria-label={label}>
      {children}
    </ol>
  )
}

export function Receipt({
  what,
  when,
  amount,
  paid,
  record,
  rain = false,
  testId,
  data,
}: {
  what: ReactNode
  when?: ReactNode
  amount?: ReactNode
  /** A second figure under the first: what it paid. */
  paid?: ReactNode
  record?: ReactNode
  /** Money moved to the rider because of rain: it carries the accent mark. */
  rain?: boolean
  testId?: string
  data?: Record<`data-${string}`, string>
}) {
  return (
    <li className={`receipt${rain ? ' receipt--rain' : ''}`} data-testid={testId} {...data}>
      <span className="receipt__what">{what}</span>
      <span className="receipt__amount">{amount}</span>
      <span className="receipt__when mono">{when}</span>
      <span className="receipt__record mono">
        {paid ? <span className="receipt__paid">{paid}</span> : null}
        {record}
      </span>
    </li>
  )
}
