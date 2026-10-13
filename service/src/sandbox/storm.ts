import type { StateStore } from '../stores/state'

const STORM_KEY = 'sandbox:storm'

export interface Storm {
  wet: boolean
  /** When the switch was last moved; null if it never was. */
  since: number | null
}

/** Position of the simulator cell's storm switch. Dry until someone turns it on. */
export async function readStorm(state: StateStore): Promise<Storm> {
  const stored = await state.get(STORM_KEY)
  if (stored && typeof stored === 'object' && !Array.isArray(stored) && typeof stored.wet === 'boolean') {
    return { wet: stored.wet, since: typeof stored.since === 'number' ? stored.since : null }
  }
  return { wet: false, since: null }
}

export async function writeStorm(state: StateStore, wet: boolean, now: number): Promise<Storm> {
  const storm: Storm = { wet, since: now }
  await state.set(STORM_KEY, { wet, since: now })
  return storm
}
