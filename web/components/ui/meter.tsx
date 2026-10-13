import type { CSSProperties, ReactNode } from 'react'

/**
 * A limit meter: ink fill on a lighter track, and a hard tick at the limit that the fill never passes. An
 * optional dashed pill beside it shows what did not fit.
 */
export function Meter({
  share,
  label,
  size = 'md',
  overflow = false,
  className,
}: {
  /** In use as a share of the limit, 0 to 1 (more when the pool shrank under cover already sold). */
  share: number
  /** Read out in full: "71% of the limit is in use". */
  label: string
  size?: 'sm' | 'md' | 'lg'
  /** Show the dashed pill for a sale that did not fit. */
  overflow?: boolean
  className?: string
}) {
  const clamped = Number.isFinite(share) ? Math.max(0, Math.min(1, share)) : 1
  return (
    <span className={`meter-row${overflow ? ' meter-row--over' : ''}${className ? ` ${className}` : ''}`}>
      <span
        className={`meter meter--${size}`}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped * 1000) / 10}
        aria-valuetext={label}
        aria-label={label}
      >
        <i style={{ '--p': clamped } as CSSProperties} />
      </span>
      {overflow ? <span className="meter-next" aria-hidden="true" /> : null}
    </span>
  )
}

/** The mono line under a meter: what is in use, what is left, where the limit is. */
export function MeterCaps({ children }: { children: ReactNode }) {
  return <p className="meter-caps mono">{children}</p>
}
