import { recoverAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { keyFromLatLon } from '../src/cells'
import {
  type Quote,
  type Reading,
  hashQuote,
  hashReport,
  quoteDomain,
  quoteTypedData,
  reportDomain,
  reportTypedData,
  signDigest,
  signQuote,
} from '../src/eip712'

// Reference values read from the contracts on a local chain (chain id 31337): `WeatherIndex` and `CoverBook`
// deployed by the first dev account at nonces 0 and 1, then `DOMAIN_SEPARATOR`-backed `hashQuote` and
// `hashReport` called with the arguments below. The signatures are `cast wallet sign --no-hash` over those
// digests with the private key 0x…01.
const CHAIN_ID = 31337
const WEATHER_INDEX = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const COVER_BOOK = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512'
const KEY_ONE = `0x${'00'.repeat(31)}01` as const

const warsaw = keyFromLatLon(52.23, 21.01)
const sumburgh = keyFromLatLon(59.88, -1.296)

const quote: Quote = {
  holder: '0x1111111111111111111111111111111111111111',
  key: warsaw,
  start: 1791873600n,
  end: 1791874200n,
  ratePerSecond: 100n,
  premium: 12345n,
  expiry: 1791873500n,
  salt: `0x${'00'.repeat(31)}01`,
}

const wetReading: Reading = { key: warsaw, from: 1791873300n, to: 1791873600n, wetSeconds: 300 }
const dryReading: Reading = { key: sumburgh, from: 1791873000n, to: 1791873600n, wetSeconds: 0 }

describe('quote digest', () => {
  const domain = quoteDomain(CHAIN_ID, COVER_BOOK)

  it('equals CoverBook.hashQuote', () => {
    expect(warsaw).toBe(18446756288596545460n)
    expect(hashQuote(quote, domain)).toBe('0xf41fb0605445d89a32e7fa7f789250d665f9c3acdbc8a266554f0bbc1c46649c')
  })

  it('changes with every field of the quote and with the domain', () => {
    const base = hashQuote(quote, domain)
    const variants: Quote[] = [
      { ...quote, holder: '0x2222222222222222222222222222222222222222' },
      { ...quote, key: sumburgh },
      { ...quote, start: quote.start + 60n },
      { ...quote, end: quote.end + 60n },
      { ...quote, ratePerSecond: 101n },
      { ...quote, premium: 12346n },
      { ...quote, expiry: quote.expiry + 1n },
      { ...quote, salt: `0x${'00'.repeat(31)}02` },
    ]
    const digests = new Set(variants.map((variant) => hashQuote(variant, domain)))
    expect(digests.size).toBe(variants.length)
    expect(digests.has(base)).toBe(false)
    expect(hashQuote(quote, quoteDomain(10143, COVER_BOOK))).not.toBe(base)
    expect(hashQuote(quote, quoteDomain(CHAIN_ID, WEATHER_INDEX))).not.toBe(base)
  })

  it('signs the way an Ethereum signer does', async () => {
    const signature = signQuote(quote, KEY_ONE, domain)
    expect(signature).toBe(
      '0xb15b0b21fd5d4cf103c280378eaaa64a82849961246bfc21e4f46fdf601b42030a7dacaee93b4b2bbed104e0ec1449b97d0264cb1ca68aea6ee5173c660c81711c',
    )
    const viaWallet = await privateKeyToAccount(KEY_ONE).signTypedData(quoteTypedData(quote, domain))
    expect(viaWallet).toBe(signature)
  })
})

describe('report digest', () => {
  const domain = reportDomain(CHAIN_ID, WEATHER_INDEX)

  it('equals WeatherIndex.hashReport for an empty report', () => {
    expect(hashReport([], 1791873605n, domain)).toBe(
      '0x66ddf20a8fd8d1c6e823be25875ba8bd7873e2ac776db863e199111973a944a1',
    )
  })

  it('equals WeatherIndex.hashReport for one reading', () => {
    expect(hashReport([wetReading], 1791873605n, domain)).toBe(
      '0xa0ce463a81107a512a46ebe24c04fb697749c89ef9e0cd5126b2334546229cf1',
    )
  })

  it('equals WeatherIndex.hashReport for several readings', () => {
    expect(sumburgh).toBe(18446756945726541302n)
    expect(hashReport([wetReading, dryReading], 1791873606n, domain)).toBe(
      '0xacb25f9008d3dcb9fdce1fd2ae74de901f8fba3c47919aa4d76f5ee93c17df9e',
    )
  })

  it('depends on the order of the readings and on the issue time', () => {
    const base = hashReport([wetReading, dryReading], 1791873606n, domain)
    expect(hashReport([dryReading, wetReading], 1791873606n, domain)).not.toBe(base)
    expect(hashReport([wetReading, dryReading], 1791873607n, domain)).not.toBe(base)
  })

  it('matches what a wallet signs for the same typed data', async () => {
    const privateKey = generatePrivateKey()
    const digest = hashReport([wetReading, dryReading], 1791873606n, domain)
    const viaWallet = await privateKeyToAccount(privateKey).signTypedData(
      reportTypedData([wetReading, dryReading], 1791873606n, domain),
    )
    expect(signDigest(digest, privateKey)).toBe(viaWallet)
  })
})

describe('signDigest', () => {
  it('produces the canonical 65-byte signature', () => {
    expect(signDigest('0xa0ce463a81107a512a46ebe24c04fb697749c89ef9e0cd5126b2334546229cf1', KEY_ONE)).toBe(
      '0x824f3d507bb2e45615c053580b04b84175037ca9af76f4284182d1c57d0a8f0f03ace39762079cdefe245691d1c006b8020257c1d3852ad3093ce8dcb20f3b741b',
    )
  })

  it('recovers to the signer for fresh keys', async () => {
    for (let i = 0; i < 8; i++) {
      const privateKey = generatePrivateKey()
      const digest = hashReport([{ ...wetReading, wetSeconds: i }], 1791873605n, reportDomain(CHAIN_ID, WEATHER_INDEX))
      const signature = signDigest(digest, privateKey)
      expect(signature).toMatch(/^0x[0-9a-f]{128}(1b|1c)$/)
      expect(await recoverAddress({ hash: digest, signature })).toBe(privateKeyToAddress(privateKey))
    }
  })

  it('rejects a malformed key', () => {
    expect(() => signDigest(`0x${'00'.repeat(32)}`, '0x1234')).toThrow()
  })
})
