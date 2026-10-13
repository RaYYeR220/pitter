'use client'

import { useEffect, useState } from 'react'
import type { AreaWeather } from '@/lib/chain/reader'
import type { PoolView } from '@/lib/pool'
import { useRuntime } from './runtime'

const INTERVAL_MS = 30_000

/**
 * The last weather check of each of the given areas, read while shown. Added for the pool's area tiles, which
 * mark the areas where heavy rain is paying; it reads only what the cover history already reads per area.
 */
export function useAreaWeather(keys: readonly bigint[]): Map<bigint, AreaWeather> | null {
  const { reader } = useRuntime()
  const [weather, setWeather] = useState<Map<bigint, AreaWeather> | null>(null)
  const signature = keys.map((key) => key.toString()).join(',')

  useEffect(() => {
    if (signature === '') {
      setWeather(new Map())
      return
    }
    const wanted = signature.split(',').map((key) => BigInt(key))
    let cancelled = false
    const read = () => {
      if (globalThis.document?.visibilityState === 'hidden') return
      reader.weather(wanted).then(
        (result) => !cancelled && setWeather(result),
        () => undefined,
      )
    }
    read()
    const timer = setInterval(read, INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [reader, signature])

  return weather
}

/**
 * The last weather check of each area with cover in the pool: as the indexer listed it with the areas, or read
 * from the weather index when the pool came from the chain alone.
 */
export function usePoolAreaWeather(pool: PoolView | null): ReadonlyMap<bigint, AreaWeather> | null {
  const indexed = pool?.areaWeather ?? null
  const read = useAreaWeather(indexed || !pool ? [] : pool.state.areas.map((area) => area.key))
  return indexed ?? (pool ? read : null)
}
