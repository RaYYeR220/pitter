'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { useRuntimeStatus } from '@/hooks/runtime'

/** Shows its children only once the server has said this deployment runs in practice mode. */
export function PracticeOnly({ children }: { children: ReactNode }) {
  const state = useRuntimeStatus()
  if (state.status !== 'ready' || state.runtime.config.practice === null) return null
  return <>{children}</>
}

/** A chart wider than the screen opens on the rain, not on the dry afternoon. */
export function ScrollTo({ x, children, label }: { x: number; children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = ref.current
    if (element && element.scrollWidth > element.clientWidth) {
      element.scrollLeft = Math.max(0, x - element.clientWidth / 2)
    }
  }, [x])
  return (
    <div className="plot" ref={ref} tabIndex={0} role="group" aria-label={label}>
      {children}
    </div>
  )
}
