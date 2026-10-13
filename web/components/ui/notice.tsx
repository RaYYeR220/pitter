import type { ReactNode } from 'react'

export type BannerTone = 'stop' | 'wait' | 'done' | 'quiet'

/**
 * A plain-words message about what just happened. There are no warning colours: `stop` is square paper with an
 * ink edge, `wait` is dashed, `done` carries a filled mark, `quiet` is a caption.
 */
export function Banner({
  tone,
  children,
  alert = false,
  live = false,
  testId,
  data,
  className,
}: {
  tone: BannerTone
  children: ReactNode
  /** Announced at once: refusals and failures. */
  alert?: boolean
  /** Announced politely: progress and results. */
  live?: boolean
  testId?: string
  data?: Record<`data-${string}`, string>
  className?: string
}) {
  return (
    <div
      className={`banner banner--${tone}${className ? ` ${className}` : ''}`}
      role={alert ? 'alert' : live ? 'status' : undefined}
      data-testid={testId}
      {...data}
    >
      <i className="banner__mark" aria-hidden="true" />
      <div className="banner__body">{children}</div>
    </div>
  )
}

/** Square paper with a 2px ink top edge: forms, offers, a backer's share. */
export function Sheet({
  children,
  className,
  as: Tag = 'div',
  labelledBy,
  testId,
  data,
}: {
  children: ReactNode
  className?: string
  as?: 'div' | 'section' | 'aside' | 'form'
  labelledBy?: string
  testId?: string
  data?: Record<`data-${string}`, string>
}) {
  return (
    <Tag className={`sheet-slip${className ? ` ${className}` : ''}`} aria-labelledby={labelledBy} data-testid={testId} {...data}>
      {children}
    </Tag>
  )
}

/** The plain marker on every action that asks for Face ID or fingerprint again. */
export function AsksAgain({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p className="asks mono" id={id}>
      <svg className="asks__glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M2 7V2h5M17 2h5v5M22 17v5h-5M7 22H2v-5" />
        <path d="M8 9v2M16 9v2M12 8.5v5h-1.5M8.5 16q3.5 2.5 7 0" />
      </svg>
      <span>{children}</span>
    </p>
  )
}

/** A section of a product page: a heading, an optional line under it, then its body. */
export function Block({
  id,
  title,
  lede,
  children,
  className,
  testId,
  data,
  headingLevel = 2,
}: {
  id?: string
  title: ReactNode
  lede?: ReactNode
  children: ReactNode
  className?: string
  testId?: string
  data?: Record<`data-${string}`, string>
  headingLevel?: 2 | 3
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3'
  const headingId = id ? `${id}-h` : undefined
  return (
    <section
      className={`block${className ? ` ${className}` : ''}`}
      id={id}
      aria-labelledby={headingId}
      data-testid={testId}
      {...data}
    >
      <Heading className="h-block" id={headingId}>
        {title}
      </Heading>
      {lede ? <p className="block__lede">{lede}</p> : null}
      {children}
    </section>
  )
}
