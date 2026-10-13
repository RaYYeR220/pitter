'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { copy } from '@/lib/copy'
import { RuntimeProvider, useRuntimeStatus } from '@/hooks/runtime'

function Header() {
  const state = useRuntimeStatus()
  const practice = state.status === 'ready' && state.runtime.config.practice !== null
  return (
    <header className="site">
      <a className="skip" href="#main">
        {copy.nav.skip}
      </a>
      <Link className="brand" href="/">
        {copy.nav.home}
      </Link>
      <nav>
        <Link href="/app">{copy.nav.cover}</Link>
        <Link href="/pool">{copy.nav.pool}</Link>
        <Link href="/docs">{copy.nav.docs}</Link>
      </nav>
      {practice ? (
        <span className="badge" data-testid="practice-badge">
          {copy.status.practiceBadge}
        </span>
      ) : null}
    </header>
  )
}

/** Renders its children once the app has started, and says so plainly when it cannot start. */
export function Ready({ children }: { children: ReactNode }) {
  const state = useRuntimeStatus()
  if (state.status === 'loading') return <p aria-live="polite">{copy.status.loading}</p>
  if (state.status === 'failed') {
    return (
      <section role="alert">
        <p>{copy.status.unreachable}</p>
        <button type="button" onClick={state.retry}>
          {copy.status.retry}
        </button>
      </section>
    )
  }
  return <>{children}</>
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <RuntimeProvider>
      <Header />
      <main id="main">{children}</main>
    </RuntimeProvider>
  )
}
