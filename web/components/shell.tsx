'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { copy } from '@/lib/copy'
import { RuntimeProvider, useRuntimeStatus } from '@/hooks/runtime'
import { Hairline } from './ui/hairline'
import { Banner } from './ui/notice'
import { DaylightToggle } from './ui/theme'

const LINKS = [
  { href: '/app', label: copy.nav.cover, wideOnly: false },
  { href: '/pool', label: copy.nav.pool, wideOnly: false },
  { href: '/docs', label: copy.nav.docs, wideOnly: true },
] as const

function Header() {
  const state = useRuntimeStatus()
  const pathname = usePathname()
  const practice = state.status === 'ready' && state.runtime.config.practice !== null
  return (
    <header className="bar">
      <a className="skip" href="#main">
        {copy.nav.skip}
      </a>
      <div className="bar__in">
        <Link className="mark" href="/">
          {copy.nav.home}
        </Link>
        <nav className="bar__nav">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              className={`lnk${link.wideOnly ? ' lnk--wide-only' : ''}`}
              href={link.href}
              aria-current={pathname === link.href ? 'page' : undefined}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="bar__end">
          {practice ? (
            <span className="badge mono" data-testid="practice-badge">
              {copy.status.practiceBadge}
            </span>
          ) : null}
          <DaylightToggle label={copy.screen.daylight} hint={copy.screen.daylightHint} />
        </div>
      </div>
    </header>
  )
}

function Footer() {
  return (
    <footer className="foot">
      <div className="foot__in">
        <p className="foot__line">{copy.footer.line}</p>
        <p className="foot__links">
          {LINKS.map((link) => (
            <Link key={link.href} className="lnk" href={link.href}>
              {link.label}
            </Link>
          ))}
        </p>
      </div>
    </footer>
  )
}

/** Renders its children once the app has started, and says so plainly when it cannot start. */
export function Ready({ children }: { children: ReactNode }) {
  const state = useRuntimeStatus()
  if (state.status === 'loading') {
    return (
      <div className="starting" aria-live="polite">
        <p className="mono">{copy.status.loading}</p>
        <Hairline mode="loop" periodSeconds={2.4} />
      </div>
    )
  }
  if (state.status === 'failed') {
    return (
      <div className="starting">
        <Banner tone="stop" alert>
          <p>{copy.status.unreachable}</p>
          <button type="button" className="btn btn--line" onClick={state.retry}>
            {copy.status.retry}
          </button>
        </Banner>
      </div>
    )
  }
  return <>{children}</>
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <RuntimeProvider>
      <div className="sheet">
        <div className="floor floor--wash" aria-hidden="true" />
        <div className="floor floor--rules" aria-hidden="true" />
        <div className="floor floor--first" aria-hidden="true" />
        <Header />
        <main id="main" className="main">
          {children}
        </main>
        <Footer />
        <div className="floor floor--grain" aria-hidden="true" />
      </div>
    </RuntimeProvider>
  )
}
