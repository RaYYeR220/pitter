import { join } from 'node:path'
import { type Quote, coverBookAbi, coverPoolAbi, quoteDomain, signQuote, testDollarAbi, weatherIndexAbi } from '@cover/core'
import {
  type Abi,
  type Address,
  type Hex,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  maxUint256,
} from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'

const artifactsDir = join(import.meta.dir, '..', '..', 'contracts', 'out')
const artifactPath = (name: string) => join(artifactsDir, `${name}.sol`, `${name}.json`)

/** Whether a local chain can be started and the contracts deployed from the Foundry build. */
export async function localChainAvailable(): Promise<boolean> {
  if (!Bun.which('anvil')) return false
  for (const name of ['TestDollar', 'WeatherIndex', 'CoverPool', 'CoverBook']) {
    if (!(await Bun.file(artifactPath(name)).exists())) return false
  }
  return true
}

async function bytecodeOf(name: string): Promise<Hex> {
  const artifact = (await Bun.file(artifactPath(name)).json()) as { bytecode: { object: Hex } }
  return artifact.bytecode.object
}

export type LocalChain = Awaited<ReturnType<typeof startLocalChain>>

/**
 * Starts a local chain whose clock begins at `genesisTime`, deploys the test dollar, the weather index, the pool
 * and the book, funds the pool and gives the holder dollars to buy cover with. Keys are generated per run.
 */
export async function startLocalChain(genesisTime: number) {
  const port = 20_000 + Math.floor(Math.random() * 20_000)
  const rpcUrl = `http://127.0.0.1:${port}`
  const node = Bun.spawn(['anvil', '--port', String(port), '--timestamp', String(genesisTime), '--silent'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })

  const chain = defineChain({
    id: 31337,
    name: 'local',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  })
  const transport = http(rpcUrl)
  const client = createPublicClient({ chain, transport })
  const control = createTestClient({ chain, transport, mode: 'anvil' })
  const wallet = createWalletClient({ chain, transport })

  for (let attempt = 0; ; attempt++) {
    try {
      await client.getChainId()
      break
    } catch (error) {
      if (attempt > 100) throw error
      await Bun.sleep(100)
    }
  }

  const [owner, provider, holder, forwarder, treasury, stranger] = (await wallet.getAddresses()) as [
    Address,
    Address,
    Address,
    Address,
    Address,
    Address,
  ]
  const reporterKey = generatePrivateKey()
  const underwriterKey = generatePrivateKey()

  const send = async (hash: Hex) => {
    const receipt = await client.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`)
    return receipt
  }
  const deploy = async (name: string, abi: Abi, args: readonly unknown[]): Promise<Address> => {
    const hash = await wallet.deployContract({ account: owner, abi, bytecode: await bytecodeOf(name), args })
    const receipt = await send(hash)
    if (!receipt.contractAddress) throw new Error(`${name} was not deployed`)
    return receipt.contractAddress
  }

  const token = await deploy('TestDollar', testDollarAbi, [owner])
  const weatherIndex = await deploy('WeatherIndex', weatherIndexAbi, [owner, privateKeyToAddress(reporterKey)])
  const coverPool = await deploy('CoverPool', coverPoolAbi, [token, owner, treasury, 'Cover Pool Share', 'cvUSD'])
  const coverBook = await deploy('CoverBook', coverBookAbi, [
    token,
    coverPool,
    weatherIndex,
    privateKeyToAddress(underwriterKey),
    treasury,
    0n,
    500_000_000n,
    owner,
  ])

  await send(await wallet.writeContract({ account: owner, address: coverPool, abi: coverPoolAbi, functionName: 'setBook', args: [coverBook] }))
  await send(
    await wallet.writeContract({ account: owner, address: weatherIndex, abi: weatherIndexAbi, functionName: 'setForwarder', args: [forwarder, true] }),
  )
  for (const account of [provider, holder]) {
    await send(await wallet.writeContract({ account: owner, address: token, abi: testDollarAbi, functionName: 'drip', args: [account] }))
  }
  await send(await wallet.writeContract({ account: provider, address: token, abi: testDollarAbi, functionName: 'approve', args: [coverPool, maxUint256] }))
  await send(
    await wallet.writeContract({ account: provider, address: coverPool, abi: coverPoolAbi, functionName: 'deposit', args: [1_000_000_000n, provider] }),
  )
  await send(await wallet.writeContract({ account: holder, address: token, abi: testDollarAbi, functionName: 'approve', args: [coverBook, maxUint256] }))

  let salt = 0n
  return {
    rpcUrl,
    client,
    wallet,
    accounts: { owner, provider, holder, forwarder, treasury, stranger },
    contracts: { token, weatherIndex, coverPool, coverBook },
    reporterKey,
    send,

    /** The next block is mined at exactly `timestamp`. */
    at: (timestamp: number) => control.setNextBlockTimestamp({ timestamp: BigInt(timestamp) }),

    /** Buys cover for `key` over `[start, end)` at `ratePerSecond`, with a quote signed by the underwriter. */
    buy: async (key: bigint, start: number, end: number, ratePerSecond: bigint, premium: bigint) => {
      const quote: Quote = {
        holder,
        key,
        start: BigInt(start),
        end: BigInt(end),
        ratePerSecond,
        premium,
        expiry: BigInt(end),
        salt: `0x${(++salt).toString(16).padStart(64, '0')}`,
      }
      const signature = signQuote(quote, underwriterKey, quoteDomain(chain.id, coverBook))
      await send(await wallet.writeContract({ account: holder, address: coverBook, abi: coverBookAbi, functionName: 'buy', args: [quote, signature] }))
      return client.readContract({ address: coverBook, abi: coverBookAbi, functionName: 'policyCount' })
    },

    balanceOf: (account: Address) => client.readContract({ address: token, abi: testDollarAbi, functionName: 'balanceOf', args: [account] }),
    lastTo: (key: bigint) => client.readContract({ address: weatherIndex, abi: weatherIndexAbi, functionName: 'lastTo', args: [key] }),
    wetSeconds: (key: bigint, from: bigint, to: bigint) =>
      client.readContract({ address: weatherIndex, abi: weatherIndexAbi, functionName: 'wetSeconds', args: [key, from, to] }),
    heartbeat: () => client.readContract({ address: weatherIndex, abi: weatherIndexAbi, functionName: 'heartbeat' }),

    stop: async () => {
      node.kill()
      await node.exited
    },
  }
}
