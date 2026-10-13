import { describe, expect, it } from 'vitest'
import {
  formatClock,
  formatCountdown,
  formatDay,
  formatDayAndClock,
  formatDollars,
  formatDuration,
  formatPercent,
  parseDollars,
  perMinute,
  shortAccount,
} from '@/lib/format'

describe('formatDollars', () => {
  it('shows two decimals from a cent upwards', () => {
    expect(formatDollars(0n)).toBe('$0.00')
    expect(formatDollars(10_000n)).toBe('$0.01')
    expect(formatDollars(120_000n)).toBe('$0.12')
    expect(formatDollars(1_234_567_890n)).toBe('$1,234.57')
  })

  it('keeps the digits of an amount under a cent', () => {
    expect(formatDollars(4_000n)).toBe('$0.004')
    expect(formatDollars(1_500n)).toBe('$0.002')
    expect(formatDollars(250n)).toBe('$0.0003')
    expect(formatDollars(900n)).toBe('$0.0009')
    expect(formatDollars(20n)).toBe('under $0.0001')
  })

  it('marks gains and losses', () => {
    expect(formatDollars(120_000n, { sign: true })).toBe('+$0.12')
    expect(formatDollars(-120_000n)).toBe('-$0.12')
    expect(formatDollars(0n, { sign: true })).toBe('$0.00')
  })
})

describe('parseDollars', () => {
  it('reads dollars and cents', () => {
    expect(parseDollars('12')).toBe(12_000_000n)
    expect(parseDollars(' $12.5 ')).toBe(12_500_000n)
    expect(parseDollars('0,25')).toBe(250_000n)
    expect(parseDollars('0.000001')).toBe(1n)
  })

  it('refuses anything else', () => {
    for (const text of ['', 'abc', '-1', '1.2.3', '1e6', '0.0000001', '12 dollars']) {
      expect(parseDollars(text)).toBeNull()
    }
  })
})

describe('time', () => {
  it('turns a rate per second into a rate per minute', () => {
    expect(perMinute(2000n)).toBe(120_000n)
  })

  it('writes durations in words', () => {
    expect(formatDuration(1)).toBe('1 second')
    expect(formatDuration(45)).toBe('45 seconds')
    expect(formatDuration(600)).toBe('10 minutes')
    expect(formatDuration(3600)).toBe('1 hour')
    expect(formatDuration(3900)).toBe('1 hour 5 minutes')
    expect(formatDuration(-5)).toBe('0 seconds')
  })

  it('writes countdowns as a clock', () => {
    expect(formatCountdown(245_000)).toBe('4:05')
    expect(formatCountdown(3_845_000)).toBe('1:04:05')
    expect(formatCountdown(-1)).toBe('0:00')
    expect(formatCountdown(999)).toBe('0:01')
  })

  it('writes the time of day in a given zone', () => {
    expect(formatClock(1_791_878_700, 'UTC')).toBe('08:05')
    expect(formatDayAndClock(1_791_878_700, 'UTC')).toBe('13 Oct, 08:05')
    expect(formatDay(1_791_849_600, 'UTC')).toBe('13 Oct')
  })
})

describe('labels', () => {
  it('shortens an account number', () => {
    expect(shortAccount('0x58d970780565E4C064369AD80eEC2D3581d6d75D')).toBe('0x58d9…d75D')
    expect(shortAccount('0x1234')).toBe('0x1234')
  })

  it('writes shares as percentages', () => {
    expect(formatPercent(1n, 4n)).toBe('25%')
    expect(formatPercent(1n, 3n)).toBe('33.3%')
    expect(formatPercent(5n, 0n)).toBe('0%')
  })
})
