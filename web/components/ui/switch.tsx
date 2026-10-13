import Link from 'next/link'
import type { ReactNode } from 'react'

/**
 * The cover switch: the primary action. An ink pill carrying a knob with the 1 mm line on it; when cover is on
 * it turns into a pressed-in well with the knob on the right.
 */
export function CoverSwitch({
  on,
  disabled = false,
  busy = false,
  label,
  sub,
  onToggle,
  testId,
  describedBy,
}: {
  on: boolean
  disabled?: boolean
  /** Waiting on the network: the knob stays where it is going, the pill dims. */
  busy?: boolean
  label: ReactNode
  sub?: ReactNode
  onToggle: () => void
  testId?: string
  describedBy?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-describedby={describedBy}
      aria-busy={busy || undefined}
      className="switch"
      disabled={disabled}
      onClick={onToggle}
      data-testid={testId}
    >
      <i className="switch__knob" aria-hidden="true" />
      <span className="switch__label">{label}</span>
      {sub ? <small className="switch__sub">{sub}</small> : null}
    </button>
  )
}

/** The same pill as a link, for the landing: the button is the control it starts. */
export function SwitchLink({ href, children, testId }: { href: string; children: ReactNode; testId?: string }) {
  return (
    <Link href={href} className="switch switch--link" data-testid={testId}>
      <i className="switch__knob" aria-hidden="true" />
      <span className="switch__label">{children}</span>
    </Link>
  )
}
