import type { Quote } from '@cover/core/eip712'
import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem'
import type { Authorization } from '../chain/erc3009'
import { parseHealth, type HealthReport } from '../config'
import { BAD_RESPONSE, NETWORK, ServiceFailure, TIMEOUT } from './errors'

/** One stretch of a quoted window with the forecast it was priced from. */
export interface PriceSlot {
  start: number
  end: number
  seconds: number
  forecastMmPerHour: number | null
  /** Chance of rain within the slot's hour, in percent. */
  precipitationProbability: number | null
  /** What the slot was priced at: the chance, between 0 and 1, that a second of it is wet. */
  probabilityWet: number
  basis: 'nowcast' | 'hourly' | 'floor'
}

/** Everything the price of a quote was worked out from. */
export interface PriceInputs {
  expectedPayout: bigint
  expectedWetSeconds: number
  loadBps: number
  floorBps: number
  slots: PriceSlot[]
}

/** How much room the pool has for a new sale in one area. */
export interface Capacity {
  assets: bigint
  lockedExposure: bigint
  cellExposure: bigint
  globalLimit: bigint
  cellLimit: bigint
  globalRemaining: bigint
  cellRemaining: bigint
  maxPolicyPayout: bigint
  /** Largest maximum payout a new sale in this area could have right now. */
  available: bigint
}

export interface SignedQuote {
  quote: Quote
  quoteSig: Hex
  /** The digest the service says the quote has. Never signed as given: the buyer recomputes it. */
  digest: Hex
  maxPayout: bigint
  cell: { key: bigint; lat: number; lon: number }
  /** Null when the service sent no breakdown of the price. */
  inputs: PriceInputs | null
  capacity: Capacity | null
}

export interface QuoteRequest {
  lat: number
  lon: number
  /** Window start and end, unix seconds on a whole minute. */
  start: number
  end: number
  /** Payout in base units per wet second. */
  rate: bigint
  holder: Address
}

export interface BuyReceipt {
  transactionHash: Hex
  blockNumber: bigint
  policyId: bigint | null
  holder: Address
  digest: Hex
}

export interface DepositReceipt {
  transactionHash: Hex
  blockNumber: bigint
  receiver: Address
  assets: bigint
  shares: bigint | null
}

export interface TransferReceipt {
  transactionHash: Hex
  blockNumber: bigint
  from: Address
  to: Address
  value: bigint
}

export interface SettleReceipt {
  transactionHash: Hex | null
  settled: Array<{ id: bigint; paid: bigint; settledUntil: number; closed: boolean }>
  skipped: bigint[]
}

/** Headers that prove a blob request comes from the blob's owner. */
export interface BlobAuth {
  signature: Hex
  issuedAt: number
}

export interface StoredBlob {
  bytes: Uint8Array<ArrayBuffer>
  issuedAt: number
}

export interface PracticeMoney {
  transactionHash: Hex
  amount: bigint | null
}

export interface PracticeRain {
  wet: boolean
  since: number | null
}

/** What one run of the weather check did. */
export interface WeatherCheck {
  time: number
  report: {
    status: 'submitted' | 'skipped' | 'failed'
    reason: string | null
    readings: Array<{ key: bigint; from: number; to: number; wetSeconds: number; source: 'weather' | 'simulator' }>
    transactions: Hex[]
  }
  settlement: {
    settled: Array<{ id: bigint; paid: bigint; closed: boolean }>
    transactions: Hex[]
    failures: string[]
  }
}

export interface ServiceClient {
  health(): Promise<HealthReport>
  quote(request: QuoteRequest): Promise<SignedQuote>
  relayBuy(quote: SignedQuote, authorization: Authorization): Promise<BuyReceipt>
  relayDeposit(
    deposit: { assets: bigint; receiver: Address; nonce: Hex },
    authorization: Authorization,
  ): Promise<DepositReceipt>
  relayTransfer(
    transfer: { from: Address; to: Address; value: bigint; nonce: Hex },
    authorization: Authorization,
  ): Promise<TransferReceipt>
  relaySettle(ids: readonly bigint[]): Promise<SettleReceipt>
  /** The stored bytes, or null when nothing is stored under that name. */
  getBlob(owner: Address, name: string, auth: BlobAuth): Promise<StoredBlob | null>
  putBlob(owner: Address, name: string, bytes: Uint8Array<ArrayBuffer>, auth: BlobAuth): Promise<void>
  practiceMoney(address: Address): Promise<PracticeMoney>
  practiceRain(): Promise<PracticeRain>
  setPracticeRain(wet: boolean): Promise<PracticeRain>
  practiceWeatherCheck(): Promise<WeatherCheck>
}

export interface ServiceClientOptions {
  /** Where the service is mounted. */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

const BLOB_SIGNATURE_HEADER = 'x-blob-signature'
const BLOB_ISSUED_AT_HEADER = 'x-blob-issued-at'
const DEFAULT_TIMEOUT_MS = 45_000

type Json = Record<string, unknown>

class Malformed extends Error {}

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

function object(value: unknown, name: string): Json {
  if (!isObject(value)) throw new Malformed(name)
  return value
}

function list(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Malformed(name)
  return value
}

function integer(value: unknown, name: string): bigint {
  if (typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value)) return BigInt(value)
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  throw new Malformed(name)
}

function number(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Malformed(name)
  return value
}

const numberOrNull = (value: unknown, name: string) =>
  value === null || value === undefined ? null : number(value, name)

function hex(value: unknown, name: string, bytes?: number): Hex {
  if (typeof value !== 'string' || !isHex(value, { strict: true })) throw new Malformed(name)
  if (bytes !== undefined && value.length !== 2 + bytes * 2) throw new Malformed(name)
  return value.toLowerCase() as Hex
}

function address(value: unknown, name: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) throw new Malformed(name)
  return getAddress(value)
}

function parseQuote(value: unknown): Quote {
  const quote = object(value, 'quote')
  return {
    holder: address(quote.holder, 'quote.holder'),
    key: integer(quote.key, 'quote.key'),
    start: integer(quote.start, 'quote.start'),
    end: integer(quote.end, 'quote.end'),
    ratePerSecond: integer(quote.ratePerSecond, 'quote.ratePerSecond'),
    premium: integer(quote.premium, 'quote.premium'),
    expiry: integer(quote.expiry, 'quote.expiry'),
    salt: hex(quote.salt, 'quote.salt', 32),
  }
}

const BASES = new Set(['nowcast', 'hourly', 'floor'])

function parseInputs(value: unknown): PriceInputs | null {
  if (!isObject(value) || !Array.isArray(value.slots)) return null
  try {
    return {
      expectedPayout: integer(value.expectedPayout, 'inputs.expectedPayout'),
      expectedWetSeconds: number(value.expectedWetSeconds, 'inputs.expectedWetSeconds'),
      loadBps: number(value.loadBps, 'inputs.loadBps'),
      floorBps: number(value.floorBps, 'inputs.floorBps'),
      slots: value.slots.map((entry) => {
        const slot = object(entry, 'inputs.slots')
        if (typeof slot.basis !== 'string' || !BASES.has(slot.basis)) throw new Malformed('inputs.slots.basis')
        return {
          start: number(slot.start, 'inputs.slots.start'),
          end: number(slot.end, 'inputs.slots.end'),
          seconds: number(slot.seconds, 'inputs.slots.seconds'),
          forecastMmPerHour: numberOrNull(slot.forecastMmPerHour, 'inputs.slots.forecastMmPerHour'),
          precipitationProbability: numberOrNull(
            slot.precipitationProbability,
            'inputs.slots.precipitationProbability',
          ),
          probabilityWet: number(slot.probabilityWet, 'inputs.slots.probabilityWet'),
          basis: slot.basis as PriceSlot['basis'],
        }
      }),
    }
  } catch {
    return null
  }
}

const CAPACITY_FIELDS = [
  'assets',
  'lockedExposure',
  'cellExposure',
  'globalLimit',
  'cellLimit',
  'globalRemaining',
  'cellRemaining',
  'maxPolicyPayout',
  'available',
] as const

/** Reads the capacity figures the service attaches to a quote or to a refusal. Null when they are absent. */
export function parseCapacity(value: unknown): Capacity | null {
  if (!isObject(value)) return null
  try {
    const capacity = {} as Capacity
    for (const field of CAPACITY_FIELDS) capacity[field] = integer(value[field], `capacity.${field}`)
    return capacity
  } catch {
    return null
  }
}

function parseSignedQuote(value: unknown): SignedQuote {
  const body = object(value, 'body')
  const cell = object(body.cell, 'cell')
  return {
    quote: parseQuote(body.quote),
    quoteSig: hex(body.quoteSig, 'quoteSig', 65),
    digest: hex(body.digest, 'digest', 32),
    maxPayout: integer(body.maxPayout, 'maxPayout'),
    cell: { key: integer(cell.key, 'cell.key'), lat: number(cell.lat, 'cell.lat'), lon: number(cell.lon, 'cell.lon') },
    inputs: parseInputs(body.inputs),
    capacity: parseCapacity(body.capacity),
  }
}

const integerOrNull = (value: unknown, name: string) =>
  value === null || value === undefined ? null : integer(value, name)

function parseWeatherCheck(value: unknown): WeatherCheck {
  const body = object(value, 'body')
  const report = object(body.report, 'report')
  const settlement = object(body.settlement, 'settlement')
  const status = report.status
  if (status !== 'submitted' && status !== 'skipped' && status !== 'failed') throw new Malformed('report.status')
  return {
    time: number(body.time, 'time'),
    report: {
      status,
      reason: typeof report.reason === 'string' ? report.reason : null,
      readings: list(report.readings, 'report.readings').map((entry) => {
        const reading = object(entry, 'reading')
        return {
          key: integer(reading.key, 'reading.key'),
          from: number(reading.from, 'reading.from'),
          to: number(reading.to, 'reading.to'),
          wetSeconds: number(reading.wetSeconds, 'reading.wetSeconds'),
          source: reading.source === 'simulator' ? ('simulator' as const) : ('weather' as const),
        }
      }),
      transactions: list(report.transactions, 'report.transactions').map((hash) => hex(hash, 'transaction', 32)),
    },
    settlement: {
      settled: list(settlement.settled, 'settlement.settled').map((entry) => {
        const settled = object(entry, 'settled')
        return {
          id: integer(settled.id, 'settled.id'),
          paid: integer(settled.paid, 'settled.paid'),
          closed: settled.closed === true,
        }
      }),
      transactions: list(settlement.transactions, 'settlement.transactions').map((hash) =>
        hex(hash, 'transaction', 32),
      ),
      failures: list(settlement.failures, 'settlement.failures').map(String),
    },
  }
}

function quoteToWire(quote: Quote): Record<string, string> {
  return {
    holder: quote.holder,
    key: quote.key.toString(),
    start: quote.start.toString(),
    end: quote.end.toString(),
    ratePerSecond: quote.ratePerSecond.toString(),
    premium: quote.premium.toString(),
    expiry: quote.expiry.toString(),
    salt: quote.salt,
  }
}

function authorizationToWire(authorization: Authorization): Record<string, string | number> {
  return {
    validAfter: authorization.validAfter.toString(),
    validBefore: authorization.validBefore.toString(),
    v: authorization.v,
    r: authorization.r,
    s: authorization.s,
  }
}

/**
 * The HTTP client for the service mounted under `/api`. It turns the wire format (integers as decimal
 * strings) into typed values and every failure into a `ServiceFailure`; it holds no state and no secrets.
 */
export function createServiceClient(options: ServiceClientOptions = {}): ServiceClient {
  const baseUrl = (options.baseUrl ?? '/api').replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const send = (input: string, init: RequestInit) => (options.fetch ?? fetch)(input, init)

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await send(`${baseUrl}${path}`, { ...init, signal: controller.signal, cache: 'no-store' })
    } catch (error) {
      if (controller.signal.aborted) throw new ServiceFailure(0, TIMEOUT, 'The service did not answer in time')
      throw new ServiceFailure(0, NETWORK, error instanceof Error ? error.message : 'The request failed')
    } finally {
      clearTimeout(timer)
    }
    if (response.ok) return response
    throw await failureOf(response)
  }

  async function failureOf(response: Response): Promise<ServiceFailure> {
    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = null
    }
    const error = isObject(body) && isObject(body.error) ? body.error : {}
    const details: Record<string, unknown> = isObject(error.details) ? { ...error.details } : {}
    const retryAfter = Number(response.headers.get('retry-after'))
    if (Number.isFinite(retryAfter) && retryAfter > 0 && details.retryAfterSeconds === undefined) {
      details.retryAfterSeconds = retryAfter
    }
    return new ServiceFailure(
      response.status,
      typeof error.code === 'string' ? error.code : `http_${response.status}`,
      typeof error.message === 'string' ? error.message : `The service answered ${response.status}`,
      details,
    )
  }

  async function json<T>(path: string, init: RequestInit, parse: (body: unknown) => T): Promise<T> {
    const response = await request(path, init)
    try {
      return parse(await response.json())
    } catch (error) {
      if (error instanceof ServiceFailure) throw error
      throw new ServiceFailure(response.status, BAD_RESPONSE, 'The service sent an answer this app cannot read', {
        field: error instanceof Malformed ? error.message : 'body',
      })
    }
  }

  const post = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  const receipt = (body: Json) => ({
    transactionHash: hex(body.transactionHash, 'transactionHash', 32),
    blockNumber: integer(body.blockNumber, 'blockNumber'),
  })

  const blobPath = (owner: Address, name: string) => `/blobs/${owner}/${encodeURIComponent(name)}`
  const blobHeaders = (auth: BlobAuth) => ({
    [BLOB_SIGNATURE_HEADER]: auth.signature,
    [BLOB_ISSUED_AT_HEADER]: String(auth.issuedAt),
  })

  const parseRain = (value: unknown): PracticeRain => {
    const body = object(value, 'body')
    if (typeof body.wet !== 'boolean') throw new Malformed('wet')
    return { wet: body.wet, since: typeof body.since === 'number' ? body.since : null }
  }

  return {
    health: () => json('/health', { method: 'GET' }, parseHealth),

    quote(input) {
      const query = new URLSearchParams({
        lat: input.lat.toFixed(6),
        lon: input.lon.toFixed(6),
        start: String(input.start),
        end: String(input.end),
        rate: input.rate.toString(),
        holder: input.holder,
      })
      return json(`/quote?${query}`, { method: 'GET' }, parseSignedQuote)
    },

    relayBuy: (signed, authorization) =>
      json(
        '/relay/buy',
        post({ quote: quoteToWire(signed.quote), quoteSig: signed.quoteSig, ...authorizationToWire(authorization) }),
        (value) => {
          const body = object(value, 'body')
          return {
            ...receipt(body),
            policyId: integerOrNull(body.policyId, 'policyId'),
            holder: address(body.holder, 'holder'),
            digest: hex(body.digest, 'digest', 32),
          }
        },
      ),

    relayDeposit: (deposit, authorization) =>
      json(
        '/relay/deposit',
        post({
          assets: deposit.assets.toString(),
          receiver: deposit.receiver,
          nonce: deposit.nonce,
          ...authorizationToWire(authorization),
        }),
        (value) => {
          const body = object(value, 'body')
          return {
            ...receipt(body),
            receiver: address(body.receiver, 'receiver'),
            assets: integer(body.assets, 'assets'),
            shares: integerOrNull(body.shares, 'shares'),
          }
        },
      ),

    relayTransfer: (transfer, authorization) =>
      json(
        '/relay/transfer',
        post({
          from: transfer.from,
          to: transfer.to,
          value: transfer.value.toString(),
          nonce: transfer.nonce,
          ...authorizationToWire(authorization),
        }),
        (value) => {
          const body = object(value, 'body')
          return {
            ...receipt(body),
            from: address(body.from, 'from'),
            to: address(body.to, 'to'),
            value: integer(body.value, 'value'),
          }
        },
      ),

    relaySettle: (ids) =>
      json('/relay/settle', post({ ids: ids.map(String) }), (value) => {
        const body = object(value, 'body')
        return {
          transactionHash: body.transactionHash === null ? null : hex(body.transactionHash, 'transactionHash', 32),
          settled: list(body.settled, 'settled').map((entry) => {
            const settled = object(entry, 'settled')
            return {
              id: integer(settled.id, 'settled.id'),
              paid: integer(settled.paid, 'settled.paid'),
              settledUntil: number(settled.settledUntil, 'settled.settledUntil'),
              closed: settled.closed === true,
            }
          }),
          skipped: list(body.skipped, 'skipped').map((id) => integer(id, 'skipped')),
        }
      }),

    async getBlob(owner, name, auth) {
      let response: Response
      try {
        response = await request(blobPath(owner, name), { method: 'GET', headers: blobHeaders(auth) })
      } catch (error) {
        if (error instanceof ServiceFailure && error.status === 404) return null
        throw error
      }
      const issuedAt = Number(response.headers.get(BLOB_ISSUED_AT_HEADER))
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        issuedAt: Number.isFinite(issuedAt) ? issuedAt : 0,
      }
    },

    async putBlob(owner, name, bytes, auth) {
      await request(blobPath(owner, name), {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', ...blobHeaders(auth) },
        body: bytes,
      })
    },

    practiceMoney: (holder) =>
      json('/practice/money', post({ address: holder }), (value) => {
        const body = object(value, 'body')
        return {
          transactionHash: hex(body.transactionHash, 'transactionHash', 32),
          amount: integerOrNull(body.amount, 'amount'),
        }
      }),

    practiceRain: () => json('/practice/rain', { method: 'GET' }, parseRain),
    setPracticeRain: (wet) => json('/practice/rain', post({ wet }), parseRain),
    practiceWeatherCheck: () => json('/practice/weather-check', post({}), parseWeatherCheck),
  }
}
