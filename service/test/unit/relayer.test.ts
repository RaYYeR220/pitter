import { coverBookAbi, coverPoolAbi, testDollarAbi, weatherIndexAbi } from '@cover/core/abi'
import {
  encodeFunctionData,
  getAbiItem,
  parseAbi,
  parseEther,
  parseGwei,
  parseTransaction,
  recoverTransactionAddress,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
  type TransactionSerializedEIP1559,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from 'viem/accounts'
import { beforeEach, describe, expect, it } from 'vitest'
import { coreAbis } from '../../src/adapters/core'
import { Calls, assertAbisMatchAllowlist, buildAllowlist } from '../../src/chain/calls'
import { Allowlist, RELAYED_FUNCTIONS, selectorOf, type RelayedFunction } from '../../src/relayer/allowlist'
import {
  BroadcastRejected,
  InclusionUnknown,
  RelayRefused,
  RelayerUnavailable,
  SimulationReverted,
} from '../../src/relayer/errors'
import { MAX_RELAY_GAS, settleManyGas, submitGas } from '../../src/relayer/gas'
import { MemoryNonceStore } from '../../src/relayer/nonces'
import { Relayer } from '../../src/relayer/relayer'
import { FakeRpc, T0, nonceTooLow } from '../helpers/fakes'

const randomAddress = () => privateKeyToAddress(generatePrivateKey())

const contracts = {
  token: randomAddress(),
  coverBook: randomAddress(),
  coverPool: randomAddress(),
  weatherIndex: randomAddress(),
}

const CHAIN_ID = 10143
const settleMany = (ids: bigint[]) =>
  encodeFunctionData({ abi: parseAbi(['function settleMany(uint256[] ids)']), args: [ids] })

function setup(features: { x402?: boolean; sandbox?: boolean } = {}) {
  const account = privateKeyToAccount(generatePrivateKey())
  const rpc = new FakeRpc()
  const allowlist = buildAllowlist({
    contracts,
    x402: { enabled: features.x402 ?? false, facilitatorUrl: '', maxTimeoutSeconds: 120 },
    sandbox: { enabled: features.sandbox ?? false, simulatorKey: null },
  })
  let time = T0
  const relayer = new Relayer({
    chainId: CHAIN_ID,
    account,
    rpc,
    nonces: new MemoryNonceStore(),
    allowlist,
    maxFeePerGas: parseGwei('300'),
    maxPriorityFeePerGas: parseGwei('2'),
    minBalance: parseEther('1'),
    now: () => time,
  })
  return {
    account,
    rpc,
    relayer,
    calls: new Calls(coreAbis, contracts),
    advance: (seconds: number) => {
      time += seconds
    },
  }
}

const decode = (serialized: Hex) => parseTransaction(serialized as TransactionSerializedEIP1559)

describe('allow-list', () => {
  it('pins the well-known token selectors', () => {
    expect(selectorOf('transferWithAuthorization')).toBe('0xe3ee160e')
    expect(selectorOf('approve')).toBe('0x095ea7b3')
  })

  it('matches the compiled contracts', () => {
    const home: Record<RelayedFunction, Abi> = {
      buyWithAuthorization: coverBookAbi as Abi,
      buy: coverBookAbi as Abi,
      settleMany: coverBookAbi as Abi,
      depositWithAuthorization: coverPoolAbi as Abi,
      transferWithAuthorization: testDollarAbi as Abi,
      approve: testDollarAbi as Abi,
      drip: testDollarAbi as Abi,
      submit: weatherIndexAbi as Abi,
    }
    for (const name of Object.keys(RELAYED_FUNCTIONS) as RelayedFunction[]) {
      const item = getAbiItem({ abi: home[name], name })
      expect(item?.type, name).toBe('function')
      expect(toFunctionSelector(item as never), name).toBe(selectorOf(name))
    }
    expect(() => assertAbisMatchAllowlist(coreAbis, Object.keys(RELAYED_FUNCTIONS) as RelayedFunction[])).not.toThrow()
  })

  it('notices an ABI whose function changed shape', () => {
    const drifted = {
      ...coreAbis,
      coverBook: parseAbi(['function settleMany(uint256[] ids, address to)']) as Abi,
    }

    expect(() => assertAbisMatchAllowlist(drifted, ['settleMany'])).toThrow(/coverBook ABI has no settleMany/)
  })

  it('allows only the pairs it was given', () => {
    const allowlist = new Allowlist().allow(contracts.coverBook, 'settleMany')

    expect(allowlist.check(contracts.coverBook, settleMany([1n])).name).toBe('settleMany')
    expect(() => allowlist.check(contracts.coverPool, settleMany([1n]))).toThrow(RelayRefused)
    expect(() => allowlist.check(contracts.coverBook, '0xdeadbeef')).toThrow(RelayRefused)
    expect(() => allowlist.check(contracts.coverBook, '0x')).toThrow(RelayRefused)
    expect(() => allowlist.check(contracts.coverBook, '0x12' as Hex)).toThrow(RelayRefused)
    expect(() => allowlist.check(contracts.coverBook, 'settleMany' as Hex)).toThrow(RelayRefused)
  })

  it('ignores the case of the target address', () => {
    const allowlist = new Allowlist().allow(contracts.coverBook, 'settleMany')

    expect(() => allowlist.check(contracts.coverBook.toLowerCase() as Address, settleMany([1n]))).not.toThrow()
  })

  it('keeps self-funded purchases, approvals and the faucet off by default', () => {
    const base = buildAllowlist({
      contracts,
      x402: { enabled: false, facilitatorUrl: '', maxTimeoutSeconds: 120 },
      sandbox: { enabled: false, simulatorKey: null },
    })
    const names = base.list().map((entry) => entry.name)

    expect(names.sort()).toEqual(
      ['buyWithAuthorization', 'depositWithAuthorization', 'settleMany', 'submit', 'transferWithAuthorization'].sort(),
    )
  })

  it('only allows approving the cover book', () => {
    const { calls } = setup()
    const allowlist = buildAllowlist({
      contracts,
      x402: { enabled: true, facilitatorUrl: '', maxTimeoutSeconds: 120 },
      sandbox: { enabled: false, simulatorKey: null },
    })

    expect(() => {
      const call = calls.approve(contracts.coverBook, 1n)
      allowlist.check(call.to, call.data)
    }).not.toThrow()
    const elsewhere = calls.approve(randomAddress(), 1n)
    expect(() => allowlist.check(elsewhere.to, elsewhere.data)).toThrow(/arguments_not_allowed/)
  })
})

describe('gas limits', () => {
  it('grow with the batch and stay under the relay maximum', () => {
    expect(settleManyGas(1)).toBe(280_000n)
    expect(settleManyGas(10)).toBeLessThanOrEqual(MAX_RELAY_GAS)
    expect(submitGas({ known: 0, fresh: 0 })).toBe(75_000n)
    expect(submitGas({ known: 0, fresh: 20 })).toBeLessThanOrEqual(MAX_RELAY_GAS)
    expect(submitGas({ known: 20, fresh: 0 })).toBeLessThan(submitGas({ known: 0, fresh: 20 }))
  })
})

describe('relayer', () => {
  let context: ReturnType<typeof setup>

  beforeEach(() => {
    context = setup()
  })

  it('signs exactly what it simulated, with explicit gas, nonce and fees and no value', async () => {
    const { relayer, rpc, calls, account } = context
    rpc.chainNonce = 7
    const call = calls.settleMany([1n, 2n])

    const result = await relayer.execute(call)

    expect(result.function).toBe('settleMany')
    expect(result.status).toBe('success')
    expect(rpc.simulated).toEqual([{ from: account.address, to: call.to, data: call.data, gas: call.gas }])
    const tx = decode(rpc.sent[0]!)
    expect(tx).toMatchObject({
      chainId: CHAIN_ID,
      type: 'eip1559',
      to: call.to.toLowerCase(),
      data: call.data,
      gas: settleManyGas(2),
      nonce: 7,
      maxFeePerGas: parseGwei('300'),
      maxPriorityFeePerGas: parseGwei('2'),
    })
    expect(tx.value ?? 0n).toBe(0n)
    expect(
      await recoverTransactionAddress({ serializedTransaction: rpc.sent[0] as TransactionSerializedEIP1559 }),
    ).toBe(account.address)
  })

  it('refuses a target that is not on the allow-list without touching the node', async () => {
    const { relayer, rpc } = context

    await expect(relayer.execute({ to: randomAddress(), data: settleMany([1n]), gas: 100_000n })).rejects.toThrow(
      /target_not_allowed/,
    )
    expect(rpc.simulated).toHaveLength(0)
    expect(rpc.sent).toHaveLength(0)
    expect(rpc.chainNonceReads).toBe(0)
  })

  it('refuses a selector that is not on the allow-list', async () => {
    const { relayer, rpc } = context
    const transferOwnership = encodeFunctionData({
      abi: parseAbi(['function transferOwnership(address newOwner)']),
      args: [randomAddress()],
    })
    const plainTransfer = encodeFunctionData({
      abi: parseAbi(['function transfer(address to, uint256 amount)']),
      args: [randomAddress(), 1n],
    })

    await expect(relayer.execute({ to: contracts.coverBook, data: transferOwnership, gas: 100_000n })).rejects.toThrow(
      /selector_not_allowed/,
    )
    await expect(relayer.execute({ to: contracts.token, data: plainTransfer, gas: 100_000n })).rejects.toThrow(
      /selector_not_allowed/,
    )
    expect(rpc.sent).toHaveLength(0)
  })

  it('refuses the faucet and self-funded purchases unless they are switched on', async () => {
    const { relayer, calls } = context

    await expect(relayer.execute(calls.drip(randomAddress()))).rejects.toThrow(/selector_not_allowed/)
    await expect(relayer.execute(calls.approve(contracts.coverBook, 1n))).rejects.toThrow(/selector_not_allowed/)
  })

  it('refuses a gas limit outside its bounds', async () => {
    const { relayer, rpc } = context

    for (const gas of [0n, -1n, MAX_RELAY_GAS + 1n]) {
      await expect(relayer.execute({ to: contracts.coverBook, data: settleMany([1n]), gas })).rejects.toThrow(
        /gas_out_of_bounds/,
      )
    }
    expect(rpc.simulated).toHaveLength(0)
  })

  it('does not send a call that would revert, and keeps the nonce', async () => {
    const { relayer, rpc, calls } = context
    rpc.revertWith = '0x12345678'

    const failure = await relayer.execute(calls.settleMany([1n])).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(SimulationReverted)
    expect((failure as SimulationReverted).data).toBe('0x12345678')
    expect(rpc.sent).toHaveLength(0)

    rpc.revertWith = null
    await relayer.execute(calls.settleMany([1n]))
    expect(decode(rpc.sent[0]!).nonce).toBe(0)
  })

  it('stops when the node is on another chain', async () => {
    const { relayer, rpc, calls } = context
    rpc.chain = 143

    await expect(relayer.execute(calls.settleMany([1n]))).rejects.toThrow(RelayerUnavailable)
    await expect(relayer.execute(calls.settleMany([1n]))).rejects.toThrow(/chain_mismatch/)
    expect(rpc.simulated).toHaveLength(0)
  })

  it('stops when its balance is below the floor', async () => {
    const { relayer, rpc, calls } = context
    rpc.funds = parseEther('0.5')

    await expect(relayer.execute(calls.settleMany([1n]))).rejects.toThrow(/unfunded/)
    expect(rpc.sent).toHaveLength(0)
  })

  it('stops when the base fee is above its cap, and resumes when it falls', async () => {
    const { relayer, rpc, calls, advance } = context
    rpc.fee = parseGwei('299')

    await expect(relayer.execute(calls.settleMany([1n]))).rejects.toThrow(/gas_price_too_high/)

    rpc.fee = parseGwei('100')
    advance(5)
    await expect(relayer.execute(calls.settleMany([1n]))).resolves.toMatchObject({ status: 'success' })
  })

  it('hands out consecutive nonces to concurrent calls, one transaction at a time', async () => {
    const { relayer, rpc, calls } = context
    rpc.chainNonce = 40
    rpc.delayMs = 2

    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => relayer.execute(calls.settleMany([BigInt(i + 1)]))),
    )

    expect(results.every((result) => result.status === 'success')).toBe(true)
    expect(rpc.sent.map((tx) => decode(tx).nonce)).toEqual(Array.from({ length: 25 }, (_, i) => 40 + i))
    expect(rpc.maxInFlight).toBe(1)
    expect(rpc.chainNonceReads).toBe(1)
  })

  it('simulates each call against the state the previous one left', async () => {
    const { relayer, rpc, calls } = context
    const order: string[] = []
    rpc.simulate = async () => {
      order.push('simulate')
    }
    rpc.onSend = () => {
      order.push('send')
      return undefined
    }

    await Promise.all([relayer.execute(calls.settleMany([1n])), relayer.execute(calls.settleMany([2n]))])

    expect(order).toEqual(['simulate', 'send', 'simulate', 'send'])
  })

  it('still counts the nonce when the transaction reverts on chain', async () => {
    const { relayer, rpc, calls } = context
    rpc.onSend = (_serialized, attempt) => {
      rpc.chainNonce++
      return rpc.receipt({ status: attempt === 1 ? 'reverted' : 'success' })
    }

    const first = await relayer.execute(calls.settleMany([1n]))
    await relayer.execute(calls.settleMany([2n]))

    expect(first.status).toBe('reverted')
    expect(rpc.sent.map((tx) => decode(tx).nonce)).toEqual([0, 1])
  })

  it('re-reads the nonce and retries once when the node says it is too low', async () => {
    const { relayer, rpc, calls } = context
    rpc.onSend = (_serialized, attempt) => {
      if (attempt === 1) {
        rpc.chainNonce = 12
        throw nonceTooLow()
      }
      rpc.chainNonce++
      return rpc.receipt()
    }

    const result = await relayer.execute(calls.settleMany([1n]))

    expect(result.status).toBe('success')
    expect(rpc.sent.map((tx) => decode(tx).nonce)).toEqual([0, 12])
    expect(rpc.simulated).toHaveLength(1)
  })

  it('gives up after a second nonce rejection', async () => {
    const { relayer, rpc, calls } = context
    rpc.onSend = () => {
      throw nonceTooLow()
    }

    await expect(relayer.execute(calls.settleMany([1n]))).rejects.toThrow(BroadcastRejected)
    expect(rpc.sent).toHaveLength(2)
  })

  it('re-reads the nonce from the chain after an unknown outcome', async () => {
    const { relayer, rpc, calls } = context
    rpc.onSend = (_serialized, attempt) => {
      if (attempt === 1) throw new InclusionUnknown('0xabc')
      rpc.chainNonce++
      return rpc.receipt()
    }

    await expect(relayer.execute(calls.settleMany([1n]))).rejects.toThrow(InclusionUnknown)
    rpc.chainNonce = 1
    await relayer.execute(calls.settleMany([2n]))

    expect(rpc.sent.map((tx) => decode(tx).nonce)).toEqual([0, 1])
    expect(rpc.chainNonceReads).toBe(2)
  })

  it('never sends value', async () => {
    const { relayer, rpc, calls } = context

    await relayer.execute(calls.submit('0x1234', { known: 1, fresh: 0 }))

    expect(decode(rpc.sent[0]!).value ?? 0n).toBe(0n)
  })
})
