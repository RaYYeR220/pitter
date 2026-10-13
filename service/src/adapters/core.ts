import { coverBookAbi, coverPoolAbi, testDollarAbi, weatherIndexAbi } from '@cover/core/abi'
import { cellFromKey, keyFromLatLon } from '@cover/core/cells'
import { hashQuote, hashReport, quoteDomain, reportDomain } from '@cover/core/eip712'
import { encodeAbiParameters, type Abi } from 'viem'
import type { Cells, ContractAbis, Signing } from '../ports'

/**
 * The test dollar's ABI covers everything the service calls on the dollar token; native USDC exposes the same
 * functions under the same selectors.
 */
export const coreAbis: ContractAbis = {
  coverBook: coverBookAbi as Abi,
  coverPool: coverPoolAbi as Abi,
  weatherIndex: weatherIndexAbi as Abi,
  token: testDollarAbi as Abi,
}

const reportParameters = [
  {
    type: 'tuple[]',
    components: [
      { name: 'key', type: 'uint256' },
      { name: 'from', type: 'uint64' },
      { name: 'to', type: 'uint64' },
      { name: 'wetSeconds', type: 'uint32' },
    ],
  },
  { type: 'uint64' },
  { type: 'bytes' },
] as const

export const coreSigning: Signing = {
  quoteDigest: (quote, chainId, coverBook) => hashQuote(quote, quoteDomain(chainId, coverBook)),
  reportDigest: (readings, issuedAt, chainId, weatherIndex) =>
    hashReport(readings, issuedAt, reportDomain(chainId, weatherIndex)),
  encodeReport: (readings, issuedAt, signature) =>
    encodeAbiParameters(reportParameters, [readings, issuedAt, signature]),
}

export const coreCells: Cells = {
  keyAt: (lat, lon) => keyFromLatLon(lat, lon),
  locate: (key) => {
    const { lat, lon } = cellFromKey(key)
    return { lat, lon }
  },
}
