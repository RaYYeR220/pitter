import {
  type CellObservation,
  type CellTarget,
  type FetchLike,
  type HttpResult,
  type RequestFailure,
  type SealedReport,
  cellFromLatLon,
  coverBookAbi,
  keyFromCellId,
  weatherIndexAbi,
} from '@cover/core'
import { type Address, type Hex, createPublicClient, createWalletClient, defineChain, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { type Delivery, type Handlers, type OracleSettings, type RunSummary, observeResponses, runOracle } from './oracle'

export type LocalRunOptions = {
  settings: OracleSettings
  fetch: FetchLike
  /** JSON-RPC endpoint. Needed to read the open policies and to submit; not needed with `cells`. */
  rpcUrl?: string
  coverBook?: Address
  /** Observe these points instead of the cells with open policies. Nothing is read from the chain. */
  cells?: { lat: number; lon: number }[]
  /** Signs the reports. Without it a key is generated for the run, which only a dry run can use. */
  reporterKey?: Hex
  /** Send the reports with `WeatherIndex.submit`. Only local chains are accepted. */
  submit?: boolean
  /** Pays for the submission. Defaults to the first account the node has unlocked. */
  senderKey?: Hex
  /** Unix seconds. Defaults to the wall clock. */
  now?: () => number
  log?: (message: string) => void
}

export type LocalRunResult = {
  summary: RunSummary
  /** What every source said about every observed cell, and the verdict. */
  observations: CellObservation[]
  cells: CellTarget[]
  reports: SealedReport[]
  /** Source requests that failed, with the reason. */
  failures: RequestFailure[]
  reporter: Address
  submitted: boolean
}

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/

export function isLocalRpc(rpcUrl: string): boolean {
  return LOOPBACK.test(rpcUrl)
}

/**
 * Runs the oracle outside the Chainlink Runtime Environment: the same run as the workflow, with the chain read
 * over JSON-RPC and the sources fetched directly. By default it only shows the reports it would write.
 */
export async function runLocal(options: LocalRunOptions): Promise<LocalRunResult> {
  const log = options.log ?? (() => {})
  const submit = options.submit ?? false

  if (submit && !options.rpcUrl) throw new Error('submitting needs an RPC endpoint')
  if (submit && !isLocalRpc(options.rpcUrl ?? '')) {
    throw new Error('this tool only submits to a local chain; use the workflow simulation or the keeper for a network')
  }
  if (submit && !options.reporterKey) throw new Error('submitting needs the reporter key the index trusts')
  if (!options.cells && !(options.rpcUrl && options.coverBook)) {
    throw new Error('give an RPC endpoint and the CoverBook address, or the cells to observe')
  }

  const transport = options.rpcUrl ? http(options.rpcUrl) : undefined
  const client = transport ? createPublicClient({ transport }) : undefined
  // Reports are signed for the chain the run talks to, whatever chain the settings were written for.
  const settings: OracleSettings = client ? { ...options.settings, chainId: await client.getChainId() } : options.settings
  const reporterKey = options.reporterKey ?? generatePrivateKey()

  const result: LocalRunResult = {
    summary: undefined as unknown as RunSummary,
    observations: [],
    cells: [],
    reports: [],
    failures: [],
    reporter: privateKeyToAccount(reporterKey).address,
    submitted: submit,
  }

  const chosenKeys = options.cells?.map(({ lat, lon }) => keyFromCellId(cellFromLatLon(lat, lon).id))

  const deliver = async (report: SealedReport, gasLimit: bigint): Promise<Delivery> => {
    result.reports.push(report)
    if (!submit || !client || !transport) return { accepted: false, txHash: null, detail: 'dry run, not sent' }

    const wallet = createWalletClient({ transport })
    const account = options.senderKey ? privateKeyToAccount(options.senderKey) : (await wallet.getAddresses())[0]
    if (!account) throw new Error('the node has no unlocked account: pass a sender key')
    const chain = defineChain({
      id: settings.chainId,
      name: 'local',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [options.rpcUrl ?? ''] } },
    })
    try {
      const txHash = await wallet.writeContract({
        account,
        chain,
        address: settings.weatherIndex,
        abi: weatherIndexAbi,
        functionName: 'submit',
        args: [report.payload],
        gas: gasLimit,
      })
      const receipt = await client.waitForTransactionReceipt({ hash: txHash })
      return receipt.status === 'success' ? { accepted: true, txHash } : { accepted: false, txHash, detail: 'the index rejected the report' }
    } catch (error) {
      return { accepted: false, txHash: null, detail: error instanceof Error ? (error.message.split('\n')[0] ?? 'failed') : 'failed' }
    }
  }

  const handlers: Handlers<true> = {
    now: () => (options.now ? options.now() : Math.floor(Date.now() / 1000)),

    activeCells: async () => {
      if (chosenKeys) return chosenKeys
      if (!client || !options.coverBook) return []
      return [...(await client.readContract({ address: options.coverBook, abi: coverBookAbi, functionName: 'activeCells' }))]
    },

    observe: async (effect) => {
      const results = await Promise.all(
        effect.requests.map(async (request): Promise<HttpResult> => {
          try {
            const response = await options.fetch(request.url, { method: 'GET', headers: request.headers })
            return { status: response.status, body: await response.text() }
          } catch {
            return null
          }
        }),
      )
      const observed = observeResponses(effect.cells, effect.requests, results, effect.now, effect.thresholdMmPerHour)
      result.cells = effect.cells
      result.failures = observed.failures
      result.observations = observed.observations
      return observed.observations.map((observation) => observation.verdict)
    },

    lastTo: async (keys) => {
      if (chosenKeys || !client) return keys.map(() => 0n)
      return Promise.all(
        keys.map((key) => client.readContract({ address: settings.weatherIndex, abi: weatherIndexAbi, functionName: 'lastTo', args: [key] })),
      )
    },

    reporterKey: () => reporterKey,
    deliver,
    log,
  }

  result.summary = await runOracle(settings, handlers)
  return result
}
