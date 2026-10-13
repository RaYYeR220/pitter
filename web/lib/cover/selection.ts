import { COVER_DEFAULTS } from '../config'
import { copy } from '../copy'
import {
  CITIES,
  LocationError,
  areaFromKey,
  areaOf,
  cityArea,
  locate,
  type Area,
  type ExactPosition,
  type LocationFailure,
} from './area'

export interface SelectionState {
  area: Area | null
  /** Asking the device where it is. */
  locating: boolean
  /** Why the device position could not be used. */
  problem: LocationFailure | null
  /** Payout per second of heavy rain. */
  ratePerSecond: bigint
}

/**
 * What cover is for: the area and the payout. The exact position the area was found from is handed to the
 * caller once (the shift log can keep it, encrypted) and kept nowhere here.
 */
export class CoverSelection {
  private readonly listeners = new Set<() => void>()
  private state: SelectionState = {
    area: null,
    locating: false,
    problem: null,
    ratePerSecond: COVER_DEFAULTS.defaultRate,
  }
  private readonly simulator: bigint | null
  private readonly geolocation: () => Pick<Geolocation, 'getCurrentPosition'> | undefined

  constructor(options: {
    simulatorKey: bigint | null
    geolocation?: () => Pick<Geolocation, 'getCurrentPosition'> | undefined
  }) {
    this.simulator = options.simulatorKey
    this.geolocation = options.geolocation ?? (() => globalThis.navigator?.geolocation)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): SelectionState => this.state

  get simulatorAvailable(): boolean {
    return this.simulator !== null
  }

  /** Asks the device where it is and covers that area. Returns the exact position, or null. */
  async useLocation(): Promise<ExactPosition | null> {
    this.update({ locating: true, problem: null })
    try {
      const position = await locate(this.geolocation())
      this.update({ area: areaOf(position, copy.area.yours), locating: false })
      return position
    } catch (error) {
      this.update({ locating: false, problem: error instanceof LocationError ? error.reason : 'unavailable' })
      return null
    }
  }

  chooseCity(name: string): void {
    const city = CITIES.find((entry) => entry.name === name)
    if (city) this.update({ area: cityArea(city), problem: null })
  }

  /** The practice area where the rain is switched by hand. Only in practice mode. */
  useSimulator(): void {
    if (this.simulator !== null) {
      this.update({ area: areaFromKey(this.simulator, 'simulator', copy.area.simulator), problem: null })
    }
  }

  setRate(ratePerSecond: bigint): void {
    if (COVER_DEFAULTS.rates.includes(ratePerSecond)) this.update({ ratePerSecond })
  }

  clear(): void {
    this.update({ area: null, problem: null })
  }

  private update(patch: Partial<SelectionState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
}
