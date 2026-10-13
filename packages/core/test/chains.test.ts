import { describe, expect, it } from 'vitest'
import {
  MONAD_MAINNET,
  MONAD_TESTNET,
  chains,
  deploymentRecords,
  getChain,
  getDeployment,
  isDeployed,
  parseDeployment,
} from '../src/chains'

const filled = {
  chainId: 10143,
  startBlock: 123,
  token: '0x00000000000000000000000000000000000000a1',
  testDollar: true,
  weatherIndex: '0x00000000000000000000000000000000000000a2',
  coverPool: '0x00000000000000000000000000000000000000a3',
  coverBook: '0x00000000000000000000000000000000000000a4',
  reporter: '0x00000000000000000000000000000000000000a5',
  underwriter: '',
  treasury: '',
  forwarders: ['0xB9F79d863261869B234c481D1f9A7af84AeAd192'],
}

describe('chains', () => {
  it('describes Monad mainnet and testnet', () => {
    expect(getChain(143)).toBe(chains[MONAD_MAINNET])
    expect(getChain(10143)).toBe(chains[MONAD_TESTNET])
    expect(chains[MONAD_MAINNET].cre.chainName).toBe('monad-mainnet')
    expect(chains[MONAD_TESTNET].cre.chainName).toBe('monad-testnet')
    expect(chains[MONAD_MAINNET].usdc).toBe('0x754704Bc059F8C67012fEd69BC8A327a5aafb603')
    expect(chains[MONAD_TESTNET].usdc).toBeUndefined()
  })

  it('refuses chains the product does not run on', () => {
    expect(() => getChain(1)).toThrow('unsupported chain 1')
    expect(() => getDeployment(1)).toThrow('unsupported chain 1')
    expect(isDeployed(1)).toBe(false)
  })
})

describe('deployments', () => {
  it('ships a record for both chains', () => {
    expect(deploymentRecords[MONAD_MAINNET].chainId).toBe(143)
    expect(deploymentRecords[MONAD_TESTNET].chainId).toBe(10143)
  })

  it('answers consistently for a chain whether or not it is deployed', () => {
    for (const chainId of [MONAD_MAINNET, MONAD_TESTNET]) {
      if (isDeployed(chainId)) {
        expect(getDeployment(chainId).coverBook).toMatch(/^0x[0-9a-fA-F]{40}$/)
      } else {
        expect(() => getDeployment(chainId)).toThrow('not deployed')
      }
    }
  })

  it('parses a filled record', () => {
    const deployment = parseDeployment(filled)
    expect(deployment.coverBook).toBe(filled.coverBook)
    expect(deployment.startBlock).toBe(123)
    expect(deployment.underwriter).toBe('0x0000000000000000000000000000000000000000')
    expect(deployment.forwarders).toEqual(filled.forwarders)
  })

  it('fails on a record with a missing or malformed contract address', () => {
    expect(() => parseDeployment({ ...filled, coverBook: '' })).toThrow('no coverBook address recorded for chain 10143')
    expect(() => parseDeployment({ ...filled, weatherIndex: '0x1234' })).toThrow('no weatherIndex address')
  })
})
