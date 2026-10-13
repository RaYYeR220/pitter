'use client'

import { useCallback } from 'react'
import { locate } from '@/lib/cover/area'
import type { ShiftLogState } from '@/lib/shiftlog'
import { useRuntime, useStore } from './runtime'

export interface UseShiftLog extends ShiftLogState {
  /** Its own passkey prompt, on the shift log's own namespace. */
  unlock(): Promise<boolean>
  lock(): void
  startShift(label: string): string | null
  editShift(id: string, changes: { label?: string; note?: string }): void
  endShift(id: string): void
  removeShift(id: string): void
  /** Adds the device's exact position to a shift. Resolves to false when the device would not say. */
  addCurrentSpot(id: string): Promise<boolean>
  save(): Promise<boolean>
}

export function useShiftLog(): UseShiftLog {
  const { shiftLog } = useRuntime()
  const state = useStore(shiftLog)
  return {
    ...state,
    unlock: useCallback(() => shiftLog.unlock(), [shiftLog]),
    lock: useCallback(() => shiftLog.lock(), [shiftLog]),
    startShift: useCallback((label: string) => shiftLog.startShift(label), [shiftLog]),
    editShift: useCallback(
      (id: string, changes: { label?: string; note?: string }) => shiftLog.editShift(id, changes),
      [shiftLog],
    ),
    endShift: useCallback((id: string) => shiftLog.endShift(id), [shiftLog]),
    removeShift: useCallback((id: string) => shiftLog.removeShift(id), [shiftLog]),
    addCurrentSpot: useCallback(
      async (id: string) => {
        try {
          const position = await locate(undefined, { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 })
          shiftLog.addPoint(id, { lat: position.lat, lon: position.lon, accuracy: Math.round(position.accuracy) })
          return true
        } catch {
          return false
        }
      },
      [shiftLog],
    ),
    save: useCallback(() => shiftLog.save(), [shiftLog]),
  }
}
