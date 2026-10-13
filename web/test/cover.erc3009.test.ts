import { hashQuote, quoteDomain, type Quote } from '@cover/core/eip712'
import { keccak256, recoverTypedDataAddress, toBytes, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { SigningSession } from '@/lib/account'
import {
  authorizationTypes,
  domainSeparator,
  receiveAuthorization,
  splitSignature,
  transferAuthorization,
  type TokenDomain,
} from '@/lib/chain/erc3009'

/**
 * Values below were read from the contracts themselves (`DOMAIN_SEPARATOR()`, the typehash constants and
 * `hashQuote`) on Monad testnet and mainnet. If any of them stops matching, signatures stop being accepted.
 */
const TEST_DOLLAR: Address = '0xDe6fb6D4C560C5901f733D53e591F2A0D6EB1438'
const COVER_BOOK: Address = '0x58d970780565E4C064369AD80eEC2D3581d6d75D'
const USDC_MAINNET: Address = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'
const USDC_TESTNET: Address = '0x534b2f3A21130d7a60830c2Df862319e593943A3'

const ON_CHAIN = {
  testDollarSeparator: '0x82c40edc668eb62936762118e9e4567d88d7555c7656b2ca97e3e933b9860bb6',
  usdcMainnetSeparator: '0xfe22123edc0dd4aeb912eb7948c5f0e531592c2053b3067612f427db342c93c6',
  usdcTestnetSeparator: '0xf1090f5a61ddee19528cecc447be0f91c7205fc2b34dd271fc0de87809a0a48d',
  receiveTypehash: '0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8',
  transferTypehash: '0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267',
  hashQuote: '0x0e9d61272f49a212114b1e2b1bd7d940201f6191f49dcb2f9530e60820eb33b5',
} as const

const testDollar: TokenDomain = { name: 'Test Dollar', version: '1', chainId: 10143, verifyingContract: TEST_DOLLAR }

describe('the signing domains', () => {
  it('match the separator the test dollar reports', () => {
    expect(domainSeparator(testDollar)).toBe(ON_CHAIN.testDollarSeparator)
  })

  it('match native USDC on both networks: name "USDC", version "2"', () => {
    expect(domainSeparator({ name: 'USDC', version: '2', chainId: 143, verifyingContract: USDC_MAINNET })).toBe(
      ON_CHAIN.usdcMainnetSeparator,
    )
    expect(domainSeparator({ name: 'USDC', version: '2', chainId: 10143, verifyingContract: USDC_TESTNET })).toBe(
      ON_CHAIN.usdcTestnetSeparator,
    )
    expect(domainSeparator({ name: 'USD Coin', version: '2', chainId: 143, verifyingContract: USDC_MAINNET })).not.toBe(
      ON_CHAIN.usdcMainnetSeparator,
    )
  })

  it('use the token’s own typehashes', () => {
    const typehash = (primaryType: keyof typeof authorizationTypes) => {
      const fields = authorizationTypes[primaryType].map((field) => `${field.type} ${field.name}`).join(',')
      return keccak256(toBytes(`${primaryType}(${fields})`))
    }
    expect(typehash('ReceiveWithAuthorization')).toBe(ON_CHAIN.receiveTypehash)
    expect(typehash('TransferWithAuthorization')).toBe(ON_CHAIN.transferTypehash)
  })
})

describe('the cover payment', () => {
  const quote: Quote = {
    holder: '0x1111111111111111111111111111111111111111',
    key: 18446751804650688016n,
    start: 1_800_000_000n,
    end: 1_800_000_600n,
    ratePerSecond: 2000n,
    premium: 15_000n,
    expiry: 1_800_000_100n,
    salt: `0x${'ab'.repeat(32)}`,
  }

  it('uses the digest the cover book computes for the quote as its nonce', () => {
    expect(hashQuote(quote, quoteDomain(10143, COVER_BOOK))).toBe(ON_CHAIN.hashQuote)
  })

  it('is signed by the session as a payment only the cover book can collect', async () => {
    const privateKey = Uint8Array.from({ length: 32 }, (_, i) => i + 7)
    const reference = privateKeyToAccount(`0x${Buffer.from(privateKey).toString('hex')}`)
    const session = new SigningSession({
      privateKey,
      credential: { credentialId: 'test-credential' },
      scope: { actions: ['cover.buy'], maxSpendPerHour: 1_000_000n, expiresAt: Number.MAX_SAFE_INTEGER, idleTimeoutMs: 1e12 },
      terms: async () => ({ domain: testDollar, payee: COVER_BOOK }),
      now: () => 1_800_000_000_000,
    })
    expect(session.address).toBe(reference.address)

    const nonce = hashQuote({ ...quote, holder: session.address }, quoteDomain(10143, COVER_BOOK))
    const payment = { value: quote.premium, validAfter: 0n, validBefore: quote.expiry, nonce }
    const { authorization } = await session.signCoverPayment(payment)

    const message = { from: session.address, to: COVER_BOOK, ...payment }
    const expected = await reference.signTypedData(receiveAuthorization(testDollar, message))
    expect(authorization).toEqual({ validAfter: 0n, validBefore: quote.expiry, ...splitSignature(expected) })
    expect(BigInt(authorization.s)).toBeLessThanOrEqual(
      0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n,
    )

    const signer = await recoverTypedDataAddress({
      ...receiveAuthorization(testDollar, message),
      signature: { r: authorization.r, s: authorization.s, v: BigInt(authorization.v) },
    })
    expect(signer).toBe(session.address)

    const asTransfer = await recoverTypedDataAddress({
      ...transferAuthorization(testDollar, message),
      signature: { r: authorization.r, s: authorization.s, v: BigInt(authorization.v) },
    })
    expect(asTransfer).not.toBe(session.address)
  })

  it('splits a signature into the v, r, s the token takes', () => {
    const r = `0x${'11'.repeat(32)}` as const
    const s = `0x${'22'.repeat(32)}` as const
    expect(splitSignature(`${r}${'22'.repeat(32)}1b`)).toEqual({ v: 27, r, s })
    expect(splitSignature(`${r}${'22'.repeat(32)}1c`)).toEqual({ v: 28, r, s })
  })
})
