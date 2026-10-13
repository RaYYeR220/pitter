import { IndexerError } from './client'

/**
 * Readers for the values the indexer returns. Hasura sends BigInt and Float columns as strings and Int columns
 * as numbers; each reader accepts exactly what its column can hold and throws `IndexerError('shape')` otherwise.
 */

const fail = (field: string, value: unknown): never => {
  throw new IndexerError('shape', `${field} is not what the indexer should return: ${JSON.stringify(value)}`)
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function record(value: unknown, field: string): Record<string, unknown> {
  return isRecord(value) ? value : fail(field, value)
}

export function list(value: unknown, field: string): unknown[] {
  return Array.isArray(value) ? value : fail(field, value)
}

/** A BigInt column: a decimal string, or a safe integer from a lenient endpoint. */
export function big(value: unknown, field: string): bigint {
  if (typeof value === 'string' && /^-?\d{1,78}$/.test(value)) return BigInt(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  return fail(field, value)
}

/** An Int column: a number, or its decimal string. */
export function int(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^-?\d{1,15}$/.test(value)) return Number(value)
  return fail(field, value)
}

export function intOrNull(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : int(value, field)
}

/** A Float column: a string such as `"38.725"`, or a number. */
export function float(value: unknown, field: string): number {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fail(field, value)
}

export function floatOrNull(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : float(value, field)
}

export function text(value: unknown, field: string): string {
  return typeof value === 'string' ? value : fail(field, value)
}

export function flag(value: unknown, field: string): boolean {
  return typeof value === 'boolean' ? value : fail(field, value)
}

/** A transaction hash. */
export function hash(value: unknown, field: string): `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) ? (value as `0x${string}`) : fail(field, value)
}
