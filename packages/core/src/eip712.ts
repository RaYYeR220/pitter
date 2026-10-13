import { secp256k1 } from '@noble/curves/secp256k1'
import { type Address, type Hex, concatHex, hashTypedData, numberToHex } from 'viem'

/** Terms of one cover purchase, signed by the underwriter. Mirrors the `Quote` struct of the contracts. */
export type Quote = {
  holder: Address
  key: bigint
  start: bigint
  end: bigint
  ratePerSecond: bigint
  premium: bigint
  expiry: bigint
  salt: Hex
}

/** One oracle observation: `wetSeconds` of `[from, to]` met the trigger for `key`. */
export type Reading = {
  key: bigint
  from: bigint
  to: bigint
  wetSeconds: number
}

export type TypedDomain = {
  name: string
  version: string
  chainId: number
  verifyingContract: Address
}

export const quoteTypes = {
  Quote: [
    { name: 'holder', type: 'address' },
    { name: 'key', type: 'uint256' },
    { name: 'start', type: 'uint64' },
    { name: 'end', type: 'uint64' },
    { name: 'ratePerSecond', type: 'uint128' },
    { name: 'premium', type: 'uint128' },
    { name: 'expiry', type: 'uint64' },
    { name: 'salt', type: 'bytes32' },
  ],
} as const

export const reportTypes = {
  Report: [
    { name: 'readings', type: 'Reading[]' },
    { name: 'issuedAt', type: 'uint64' },
  ],
  Reading: [
    { name: 'key', type: 'uint256' },
    { name: 'from', type: 'uint64' },
    { name: 'to', type: 'uint64' },
    { name: 'wetSeconds', type: 'uint32' },
  ],
} as const

/** EIP-712 domain of `CoverBook`, under which quotes are signed. */
export function quoteDomain(chainId: number, coverBook: Address): TypedDomain {
  return { name: 'Cover', version: '1', chainId, verifyingContract: coverBook }
}

/** EIP-712 domain of `WeatherIndex`, under which oracle reports are signed. */
export function reportDomain(chainId: number, weatherIndex: Address): TypedDomain {
  return { name: 'WeatherIndex', version: '1', chainId, verifyingContract: weatherIndex }
}

/** Typed data of a quote, in the shape wallets and `signTypedData` expect. */
export function quoteTypedData(quote: Quote, domain: TypedDomain) {
  return { domain, types: quoteTypes, primaryType: 'Quote', message: quote } as const
}

/** Typed data of a report, in the shape wallets and `signTypedData` expect. */
export function reportTypedData(readings: readonly Reading[], issuedAt: bigint, domain: TypedDomain) {
  return { domain, types: reportTypes, primaryType: 'Report', message: { readings, issuedAt } } as const
}

/** The digest `CoverBook.hashQuote` returns: what the underwriter signs and the holder uses as ERC-3009 nonce. */
export function hashQuote(quote: Quote, domain: TypedDomain): Hex {
  return hashTypedData(quoteTypedData(quote, domain))
}

/** The digest `WeatherIndex.hashReport` returns: what the reporter signs. */
export function hashReport(readings: readonly Reading[], issuedAt: bigint, domain: TypedDomain): Hex {
  return hashTypedData(reportTypedData(readings, issuedAt, domain))
}

/**
 * Signs a 32-byte digest and returns `r || s || v` with a low `s` and `v` of 27 or 28. Synchronous and free of
 * platform APIs, so it also runs where promises and Web Crypto are unavailable.
 */
export function signDigest(digest: Hex, privateKey: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('private key must be 32 bytes of hex')
  if (!/^0x[0-9a-fA-F]{64}$/.test(digest)) throw new Error('digest must be 32 bytes of hex')
  const signature = secp256k1.sign(digest.slice(2), privateKey.slice(2), { lowS: true })
  return concatHex([
    numberToHex(signature.r, { size: 32 }),
    numberToHex(signature.s, { size: 32 }),
    numberToHex(27 + signature.recovery, { size: 1 }),
  ])
}

export function signQuote(quote: Quote, privateKey: Hex, domain: TypedDomain): Hex {
  return signDigest(hashQuote(quote, domain), privateKey)
}
