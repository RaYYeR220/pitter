import type { ReactNode } from 'react'

/** Label, mono sub-line, figure: the ledger row every product screen is built from. */
export function Rows({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={`rows${className ? ` ${className}` : ''}`}>{children}</dl>
}

export function Row({
  label,
  sub,
  value,
  unit,
  valueProps,
  children,
  testId,
  className,
}: {
  label: ReactNode
  sub?: ReactNode
  value?: ReactNode
  unit?: ReactNode
  /** Attributes for the figure, such as the test id and the raw units the tests read. */
  valueProps?: Record<string, string | undefined>
  /** Anything under the row: a control, a note. */
  children?: ReactNode
  testId?: string
  className?: string
}) {
  return (
    <div className={`row${className ? ` ${className}` : ''}`} data-testid={testId}>
      <dt>
        {label}
        {sub ? <small className="mono">{sub}</small> : null}
      </dt>
      <dd>
        {value !== undefined ? <span {...valueProps}>{value}</span> : null}
        {unit ? <small className="mono">{unit}</small> : null}
      </dd>
      {children ? <div className="row__more">{children}</div> : null}
    </div>
  )
}
