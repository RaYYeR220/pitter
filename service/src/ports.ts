import type { Abi, Address, Hex } from 'viem'
import type { Quote, Reading } from './types'

/**
 * What the service needs from the shared core package. The service codes against these interfaces only;
 * `adapters/core.ts` is the one file that binds them to the package.
 */

export interface ContractAbis {
  coverBook: Abi
  coverPool: Abi
  weatherIndex: Abi
  /** The dollar token: ERC-20 with ERC-3009, plus `drip` on the test dollar. */
  token: Abi
}

export interface Signing {
  /** The digest `CoverBook.hashQuote` returns for `quote`. */
  quoteDigest(quote: Quote, chainId: number, coverBook: Address): Hex
  /** The digest `WeatherIndex.hashReport` returns. */
  reportDigest(readings: readonly Reading[], issuedAt: bigint, chainId: number, weatherIndex: Address): Hex
  /** The bytes `WeatherIndex.submit` takes. */
  encodeReport(readings: readonly Reading[], issuedAt: bigint, signature: Hex): Hex
}

export interface Cells {
  /** Index key of the cell containing a point, for the rain trigger. */
  keyAt(lat: number, lon: number): bigint
  /** Centre of the cell behind `key`. */
  locate(key: bigint): { lat: number; lon: number }
}

export interface PriceRequest {
  key: bigint
  lat: number
  lon: number
  /** Window start and end, unix seconds. */
  start: number
  end: number
  ratePerSecond: bigint
  now: number
}

export interface Price {
  /** Premium in token base units. */
  premium: bigint
  /** The per-slot inputs behind the premium, shown to the buyer as "why this price". */
  inputs: unknown
  /** Caveats about how the price was made, such as `observations_unavailable`. */
  warnings?: string[]
}

export interface Pricing {
  /** Prices a window from the current forecast. Rejects when no forecast is available. */
  price(request: PriceRequest): Promise<Price>
}

export interface ReadingsRequest {
  /** Wet or dry per key. A key the sources did not agree on is absent and gets no reading. */
  verdicts: ReadonlyMap<bigint, boolean>
  /** Last reported time per key; zero for a key that has never been reported. */
  lastTo: ReadonlyMap<bigint, bigint>
  now: number
  /** Length of the first reading of a key that has no timeline yet. */
  firstReadingSeconds: number
}

export interface WeatherReporter {
  /**
   * Asks the weather sources about each cell. The result holds a verdict only for the keys on which enough
   * independent sources answered; it never guesses.
   */
  observe(keys: readonly bigint[], now: number): Promise<Map<bigint, boolean>>
  /** Turns verdicts into readings that continue each key's timeline without gaps or overlaps. */
  buildReadings(request: ReadingsRequest): Reading[]
}

export interface CorePorts {
  abis: ContractAbis
  signing: Signing
  cells: Cells
  pricing: Pricing
  weather: WeatherReporter
}
