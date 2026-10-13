import type { CSSProperties, ReactNode } from 'react'

export type HairlineMode = 'still' | 'loop' | 'broken'

/**
 * The one hairline. It stands for the 1 mm heavy-rain line wherever it appears: under the landing figure as
 * cents accruing, under a running block as the time paid for, and broken into dashes when the weather cannot
 * be confirmed.
 */
export function Hairline({
  progress = 0,
  marks = 0,
  mode = 'still',
  periodSeconds = 30,
  left,
  right,
  className,
}: {
  /** Share filled, 0 to 1, when still. */
  progress?: number
  /** Evenly spaced ticks. */
  marks?: number
  /** `loop`: fills over `periodSeconds` and starts again. */
  mode?: HairlineMode
  periodSeconds?: number
  left?: ReactNode
  right?: ReactNode
  className?: string
}) {
  const ticks = Array.from({ length: marks }, (_, i) => (i + 1) / marks)
  const style = {
    '--p': Math.max(0, Math.min(1, progress)),
    '--period': `${periodSeconds}s`,
  } as CSSProperties
  return (
    <div className={`hair${className ? ` ${className}` : ''}`}>
      <span className={`hair__line hair__line--${mode}`} style={style} aria-hidden="true">
        {mode === 'broken' ? null : <i className="hair__fill" />}
        {ticks.map((at) => (
          <b key={at} className="hair__tick" style={{ left: `calc(${at * 100}% - 1px)` }} />
        ))}
      </span>
      {left || right ? (
        <p className="hair__caps mono">
          <span>{left}</span>
          <span>{right}</span>
        </p>
      ) : null}
    </div>
  )
}
