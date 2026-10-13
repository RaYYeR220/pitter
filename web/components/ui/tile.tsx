import type { CSSProperties, ReactNode } from 'react'

/**
 * One area of the pool as a gauge: its name, dollars in use, and a well that fills towards its top edge, which
 * is the limit. Hatched with the accent while heavy rain is falling there.
 */
export function Tile({
  name,
  value,
  sub,
  share,
  wet = false,
  label,
}: {
  name: ReactNode
  value: ReactNode
  sub?: ReactNode
  share: number
  wet?: boolean
  label: string
}) {
  const clamped = Number.isFinite(share) ? Math.max(0, Math.min(1, share)) : 1
  const full = clamped >= 0.995
  return (
    <li
      className={`tile${wet ? ' tile--wet' : ''}${full ? ' tile--full' : ''}`}
      style={{ '--p': clamped } as CSSProperties}
      aria-label={label}
    >
      <b className="tile__name">{name}</b>
      <span className="tile__value">{value}</span>
      {sub ? <span className="tile__sub mono">{sub}</span> : null}
      <span className="tile__well" aria-hidden="true">
        <i />
      </span>
    </li>
  )
}
