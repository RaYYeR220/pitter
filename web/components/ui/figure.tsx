import type { CSSProperties, ReactNode } from 'react'

export type FigureSize = 'hero' | 'screen' | 'slip' | 'second'

/**
 * The giant tracked figure every screen leads with. It sizes itself to the width it is given: the longer the
 * figure, the smaller the type, never past the size its role allows.
 */
export function Figure({
  value,
  sub,
  size = 'screen',
  wipe = false,
  label,
  className,
  testId,
  data,
}: {
  value: string
  /** A smaller tail: seconds, a unit, a tenth of a cent. */
  sub?: ReactNode
  size?: FigureSize
  /** Wipe in from the left on first paint. */
  wipe?: boolean
  /** What a screen reader hears instead of the bare figure. */
  label?: string
  className?: string
  testId?: string
  data?: Record<`data-${string}`, string>
}) {
  const chars = value.length + (typeof sub === 'string' ? sub.length * 0.4 : sub ? 1 : 0)
  return (
    <div className={`fig fig--${size}${className ? ` ${className}` : ''}`}>
      <p
        className={`fig__value${wipe ? ' fig__value--wipe' : ''}`}
        style={{ '--chars': chars } as CSSProperties}
        aria-label={label}
        data-testid={testId}
        {...data}
      >
        <span className="fig__n">{value}</span>
        {sub ? <span className="fig__sub">{sub}</span> : null}
      </p>
    </div>
  )
}

/** The sentence above a figure and the caption under it. */
export function FigureBlock({
  state,
  figure,
  caption,
  children,
}: {
  state: ReactNode
  figure: ReactNode
  caption?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="figblock">
      {state}
      {figure}
      {caption ? <div className="figblock__caption">{caption}</div> : null}
      {children}
    </div>
  )
}
