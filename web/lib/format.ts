/** Base units in one dollar: the dollar token has six decimals. */
export const DOLLAR = 1_000_000n

const DECIMALS = 6

function group(whole: bigint): string {
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Dollars for display. Two decimals as a rule; amounts under a cent keep enough digits to show what they are,
 * because a price of "$0.00 a minute" tells the reader nothing.
 */
export function formatDollars(units: bigint, options: { sign?: boolean } = {}): string {
  const negative = units < 0n
  const absolute = negative ? -units : units
  const prefix = negative ? '-' : options.sign && absolute > 0n ? '+' : ''

  let digits = 2
  if (absolute > 0n && absolute < DOLLAR / 100n) digits = absolute < DOLLAR / 1000n ? 4 : 3

  const scale = 10n ** BigInt(DECIMALS - digits)
  const rounded = (absolute + scale / 2n) / scale
  if (rounded === 0n && absolute > 0n) return `${prefix}under $0.0001`
  const divisor = 10n ** BigInt(digits)
  const whole = rounded / divisor
  const fraction = (rounded % divisor).toString().padStart(digits, '0')
  return `${prefix}$${group(whole)}.${fraction}`
}

/** Parses what a person types into an amount field. Null when it is not an amount of dollars and cents. */
export function parseDollars(text: string): bigint | null {
  const match = /^\$?\s*(\d{1,9})(?:[.,](\d{1,6}))?$/.exec(text.trim())
  if (!match) return null
  const whole = BigInt(match[1]!)
  const fraction = BigInt((match[2] ?? '').padEnd(DECIMALS, '0'))
  return whole * DOLLAR + fraction
}

/** What a rate per second comes to per minute. */
export function perMinute(perSecond: bigint): bigint {
  return perSecond * 60n
}

/** A length of time in words: "45 seconds", "12 minutes", "1 hour 5 minutes". */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const plural = (value: number, unit: string) => `${value} ${unit}${value === 1 ? '' : 's'}`
  if (total < 60) return plural(total, 'second')
  const minutes = Math.round(total / 60)
  if (minutes < 60) return plural(minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? plural(hours, 'hour') : `${plural(hours, 'hour')} ${plural(rest, 'minute')}`
}

/** A countdown as a clock: "4:05" or "1:04:05". */
export function formatCountdown(milliseconds: number): string {
  const total = Math.max(0, Math.ceil(milliseconds / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const two = (value: number) => value.toString().padStart(2, '0')
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`
}

/** Time of day of a unix timestamp, in the reader's own time zone unless one is given. */
export function formatClock(unixSeconds: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(
    new Date(unixSeconds * 1000),
  )
}

/** The calendar day of a unix timestamp: "13 Oct". */
export function formatDay(unixSeconds: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone }).format(
    new Date(unixSeconds * 1000),
  )
}

/** Day and time of a unix timestamp: "13 Oct, 14:05". */
export function formatDayAndClock(unixSeconds: number, timeZone?: string): string {
  return `${formatDay(unixSeconds, timeZone)}, ${formatClock(unixSeconds, timeZone)}`
}

/** An account number cut down to its ends. */
export function shortAccount(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`
}

/** A share of a whole as a percentage with at most one decimal. */
export function formatPercent(part: bigint, whole: bigint): string {
  if (whole <= 0n) return '0%'
  const tenths = (part * 1000n + whole / 2n) / whole
  return `${tenths / 10n}${tenths % 10n === 0n ? '' : `.${tenths % 10n}`}%`
}
