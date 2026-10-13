'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { THEME_COLOR, THEME_STORAGE_KEY } from './theme-boot'

function setThemeColor(color: string) {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta) meta.content = color
}

function systemWantsDaylight(): boolean {
  return globalThis.matchMedia?.('(prefers-contrast: more)').matches ?? false
}

function readTheme(): 'daylight' | 'dark' | null {
  const value = document.documentElement.dataset.theme
  return value === 'daylight' || value === 'dark' ? value : null
}

const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  const media = globalThis.matchMedia?.('(prefers-contrast: more)')
  media?.addEventListener('change', listener)
  return () => {
    listeners.delete(listener)
    media?.removeEventListener('change', listener)
  }
}

function isDaylight(): boolean {
  const chosen = readTheme()
  return chosen ? chosen === 'daylight' : systemWantsDaylight()
}

/** The daylight switch: dark type on a light screen for direct sun. Remembered on this device only. */
export function DaylightToggle({ label, hint }: { label: string; hint: string }) {
  const daylight = useSyncExternalStore(subscribe, isDaylight, () => false)
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])

  const toggle = () => {
    const next = daylight ? 'dark' : 'daylight'
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // A private window may refuse; the choice still holds for this page.
    }
    if (document.documentElement.dataset.weather !== 'raining') setThemeColor(THEME_COLOR[next])
    for (const listener of listeners) listener()
  }

  return (
    <button
      type="button"
      className="daylight"
      aria-pressed={ready ? daylight : undefined}
      onClick={toggle}
      title={hint}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="4.5" />
        <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" />
      </svg>
      <span className="daylight__label">{label}</span>
    </button>
  )
}

/** Floods the whole screen with the accent while heavy rain is paying, and turns it back when it stops. */
export function useFlood(raining: boolean) {
  useEffect(() => {
    const root = document.documentElement
    if (raining) {
      root.dataset.weather = 'raining'
      setThemeColor(THEME_COLOR.raining)
    } else if (root.dataset.weather) {
      delete root.dataset.weather
      setThemeColor(isDaylight() ? THEME_COLOR.daylight : THEME_COLOR.dark)
    }
  }, [raining])

  useEffect(
    () => () => {
      const root = document.documentElement
      if (root.dataset.weather) {
        delete root.dataset.weather
        setThemeColor(isDaylight() ? THEME_COLOR.daylight : THEME_COLOR.dark)
      }
    },
    [],
  )
}
