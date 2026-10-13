'use client'

import { useEffect, useState } from 'react'
import { copy } from '@/lib/copy'
import { formatDollars } from '@/lib/format'
import { Figure } from '../ui/figure'
import { Hairline } from '../ui/hairline'

/**
 * The landing's figure: an example of cover paying while it rains. At the payout it shows, one cent is earned
 * every few seconds, and the hairline passes one mark per cent. It stands still without scripts and under
 * reduced motion.
 */
export function HeroMeter({ ratePerSecond, startSeconds }: { ratePerSecond: bigint; startSeconds: number }) {
  const [seconds, setSeconds] = useState(startSeconds)
  const secondsPerCent = Number(10_000n / ratePerSecond)

  useEffect(() => {
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  // Whole cents only, so the figure moves exactly once per mark.
  const units = ((ratePerSecond * BigInt(seconds)) / 10_000n) * 10_000n
  return (
    <>
      <div className="hero__sky">
        <p className="hero__pre mono">{copy.story.heroExample}</p>
        <Figure value={formatDollars(units)} size="hero" wipe label={copy.story.heroLabel(formatDollars(units))} />
      </div>
      <Hairline
        className="hero__hair"
        mode="loop"
        marks={10}
        periodSeconds={secondsPerCent * 10}
        left={<span aria-hidden="true">{copy.story.soFar(seconds)}</span>}
        right={copy.story.perMark}
      />
    </>
  )
}
