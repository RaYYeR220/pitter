import { getAddress, zeroAddress } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import {
  blobName,
  coverRequestSchema,
  quoteSchema,
  relayBuySchema,
  relayDepositSchema,
  relaySettleSchema,
  relayTransferSchema,
  uint,
} from '../../src/validation'

const holder = privateKeyToAddress(generatePrivateKey())
const word = (byte: string) => `0x${byte.repeat(32)}`

const quote = {
  holder,
  key: '18446744073709551617',
  start: 1_800_000_000,
  end: '1800000600',
  ratePerSecond: '1000',
  premium: '42000',
  expiry: 1_799_999_900,
  salt: word('ab'),
}

const authorization = { validAfter: 0, validBefore: '1800000000', v: 27, r: word('11'), s: word('22') }

describe('uint', () => {
  it('accepts decimal strings and safe integers', () => {
    expect(uint(64).parse('18446744073709551615')).toBe(2n ** 64n - 1n)
    expect(uint(64).parse(7)).toBe(7n)
  })

  it.each(['-1', '1.5', '0x10', '1e3', '01', '', ' 1'])('rejects %j', (value) => {
    expect(uint(64).safeParse(value).success).toBe(false)
  })

  it('rejects values that do not fit', () => {
    expect(uint(64).safeParse('18446744073709551616').success).toBe(false)
    expect(uint(8).safeParse(256).success).toBe(false)
  })

  it('rejects unsafe and fractional numbers', () => {
    expect(uint(64).safeParse(2 ** 53).success).toBe(false)
    expect(uint(64).safeParse(1.5).success).toBe(false)
    expect(uint(64).safeParse(-1).success).toBe(false)
  })
})

describe('quote', () => {
  it('parses into big integers and a checksummed holder', () => {
    const parsed = quoteSchema.parse({ ...quote, holder: holder.toLowerCase() })

    expect(parsed.holder).toBe(getAddress(holder))
    expect(parsed.key).toBe(18446744073709551617n)
    expect(parsed.start).toBe(1_800_000_000n)
    expect(parsed.end).toBe(1_800_000_600n)
  })

  it('rejects the zero holder', () => {
    expect(quoteSchema.safeParse({ ...quote, holder: zeroAddress }).success).toBe(false)
  })

  it('rejects a mixed-case holder with a broken checksum', () => {
    const flipped = holder.replace(/[a-fA-F]/, (letter) =>
      letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
    )

    expect(quoteSchema.safeParse({ ...quote, holder: flipped }).success).toBe(false)
  })

  it('rejects unknown fields', () => {
    expect(quoteSchema.safeParse({ ...quote, extra: 1 }).success).toBe(false)
  })

  it('rejects a salt of the wrong length', () => {
    expect(quoteSchema.safeParse({ ...quote, salt: '0x1234' }).success).toBe(false)
  })
})

describe('relay bodies', () => {
  const signature = `0x${'cd'.repeat(65)}`

  it('accepts a well-formed purchase', () => {
    expect(relayBuySchema.safeParse({ quote, quoteSig: signature, ...authorization }).success).toBe(true)
  })

  it('rejects a recovery id other than 27 or 28', () => {
    for (const v of [0, 1, 26, 29, '27']) {
      expect(relayBuySchema.safeParse({ quote, quoteSig: signature, ...authorization, v }).success).toBe(false)
    }
  })

  it('rejects a high-s signature', () => {
    const highS = `0x${'ff'.repeat(32)}`

    expect(relayBuySchema.safeParse({ quote, quoteSig: signature, ...authorization, s: highS }).success).toBe(false)
  })

  it('rejects a quote signature that is not 65 bytes', () => {
    expect(relayBuySchema.safeParse({ quote, quoteSig: '0x1234', ...authorization }).success).toBe(false)
  })

  it('rejects a zero deposit and a zero transfer', () => {
    const deposit = { assets: '0', receiver: holder, nonce: word('01'), ...authorization }
    const transfer = { from: holder, to: holder, value: 0, nonce: word('01'), ...authorization }

    expect(relayDepositSchema.safeParse(deposit).success).toBe(false)
    expect(relayDepositSchema.safeParse({ ...deposit, assets: '1' }).success).toBe(true)
    expect(relayTransferSchema.safeParse(transfer).success).toBe(false)
    expect(relayTransferSchema.safeParse({ ...transfer, value: 1 }).success).toBe(true)
  })

  it('bounds the settle batch', () => {
    expect(relaySettleSchema.safeParse({ ids: [] }).success).toBe(false)
    expect(relaySettleSchema.safeParse({ ids: [0] }).success).toBe(false)
    expect(relaySettleSchema.safeParse({ ids: [1, 1] }).success).toBe(false)
    expect(relaySettleSchema.safeParse({ ids: Array.from({ length: 11 }, (_, i) => i + 1) }).success).toBe(false)
    expect(relaySettleSchema.parse({ ids: [1, '2'] }).ids).toEqual([1n, 2n])
  })
})

describe('cover request', () => {
  const request = { lat: '52.2297', lon: '21.0122', start: '1800000000', end: '1800000600', rate: '1000', holder }

  it('parses query-string values', () => {
    const parsed = coverRequestSchema.parse(request)

    expect(parsed.lat).toBeCloseTo(52.2297)
    expect(parsed.lon).toBeCloseTo(21.0122)
    expect(parsed.rate).toBe(1000n)
  })

  it.each([
    ['lat', '90.1'],
    ['lat', '-91'],
    ['lat', 'NaN'],
    ['lat', '5e1'],
    ['lon', '180.5'],
    ['lon', ''],
    ['rate', '0'],
    ['rate', '-5'],
    ['start', 'soon'],
  ])('rejects %s = %j', (field, value) => {
    expect(coverRequestSchema.safeParse({ ...request, [field]: value }).success).toBe(false)
  })
})

describe('blob name', () => {
  it.each(['shift-log', 'log.v1', 'a', '2026-10-13_notes'])('accepts %j', (name) => {
    expect(blobName.safeParse(name).success).toBe(true)
  })

  it.each(['', '../etc/passwd', 'UPPER', 'with space', '.hidden', 'a'.repeat(65), 'a/b', 'a%2fb'])(
    'rejects %j',
    (name) => {
      expect(blobName.safeParse(name).success).toBe(false)
    },
  )
})
