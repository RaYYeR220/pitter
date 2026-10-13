import {
  CronCapability,
  EVMClient,
  HTTPClient,
  LAST_FINALIZED_BLOCK_NUMBER,
  type NodeRuntime,
  type Runtime,
  TxStatus,
  bytesToHex,
  consensusIdenticalAggregation,
  encodeCallMsg,
  getNetwork,
  handler,
  prepareReportRequest,
  text,
} from '@chainlink/cre-sdk'
import {
  type HttpResult,
  type SealedReport,
  type Verdict,
  coverBookAbi,
  isDeployed,
  getDeployment,
  multicall3Abi,
  weatherIndexAbi,
} from '@cover/core'
import { type Address, type Hex, decodeFunctionResult, encodeFunctionData, zeroAddress } from 'viem'
import { z } from 'zod'
import {
  type Delivery,
  type Effect,
  type Handlers,
  type OracleSettings,
  type RunSummary,
  decodeVerdicts,
  encodeVerdicts,
  judgeResponses,
  runOracleSync,
} from './src/oracle'

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

export const configSchema = z.object({
  /** Cron expression with seconds. The run starts a little after the minute so that the minute it reports has passed. */
  schedule: z.string(),
  chainSelectorName: z.string(),
  isTestnet: z.boolean(),
  chainId: z.number().int().positive(),
  /** Leave empty to use the address recorded for the chain in `@cover/core`. */
  coverBook: z.union([address, z.literal('')]),
  weatherIndex: z.union([address, z.literal('')]),
  multicall3: address,
  /** Identifies the operator to the weather sources. MET Norway rejects anonymous callers. */
  userAgent: z.string().min(8),
  thresholdMmPerHour: z.number().positive(),
  intervalSeconds: z.number().int().positive(),
  maxHttpRequests: z.number().int().min(1).max(15),
  heartbeatCell: z.object({ lat: z.number(), lon: z.number() }).nullable(),
  httpTimeout: z.string(),
  httpCacheMaxAge: z.string(),
  gasLimitBase: z.string().regex(/^\d+$/),
  gasLimitPerReading: z.string().regex(/^\d+$/),
})

export type Config = z.infer<typeof configSchema>

/** Name of the secret that holds the reporter's private key. */
export const REPORTER_KEY_SECRET = 'REPORTER_KEY'

/** Keys per `lastTo` batch. One batch stays under the 5 KB limit on an EVM read request. */
export const LAST_TO_BATCH = 20

type ObserveEffect = Extract<Effect, { type: 'observe' }>

function contractAddresses(config: Config): { coverBook: Address; weatherIndex: Address } {
  if (config.coverBook !== '' && config.weatherIndex !== '') {
    return { coverBook: config.coverBook as Address, weatherIndex: config.weatherIndex as Address }
  }
  if (!isDeployed(config.chainId)) {
    throw new Error(`no contract addresses for chain ${config.chainId}: set coverBook and weatherIndex in the config`)
  }
  const deployment = getDeployment(config.chainId)
  return {
    coverBook: (config.coverBook || deployment.coverBook) as Address,
    weatherIndex: (config.weatherIndex || deployment.weatherIndex) as Address,
  }
}

export function settingsFromConfig(config: Config): OracleSettings {
  return {
    chainId: config.chainId,
    weatherIndex: contractAddresses(config).weatherIndex,
    userAgent: config.userAgent,
    thresholdMmPerHour: config.thresholdMmPerHour,
    intervalSeconds: config.intervalSeconds,
    maxHttpRequests: config.maxHttpRequests,
    heartbeatCell: config.heartbeatCell,
    gasLimitBase: BigInt(config.gasLimitBase),
    gasLimitPerReading: BigInt(config.gasLimitPerReading),
  }
}

function privateKeyFromSecret(value: string): Hex {
  const trimmed = value.trim()
  const key = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`secret ${REPORTER_KEY_SECRET} is not a 32-byte hex private key`)
  return key as Hex
}

const headerValues = (headers: Record<string, string>) => {
  const values: Record<string, { values: string[] }> = {}
  for (const name of Object.keys(headers).sort()) values[name] = { values: [headers[name] ?? ''] }
  return values
}

/**
 * Runs on every node: fetches the planned requests and reduces the answers to one verdict per cell. A request
 * that fails is a source without an answer, never an error of the run. Responses are cached briefly so that
 * the nodes of a DON judge the same data.
 */
const observeOnNode = (nodeRuntime: NodeRuntime<Config>, effect: ObserveEffect): string => {
  const http = new HTTPClient()
  const pending = effect.requests.map((request) =>
    http.sendRequest(nodeRuntime, {
      url: request.url,
      method: 'GET',
      multiHeaders: headerValues(request.headers),
      timeout: nodeRuntime.config.httpTimeout,
      cacheSettings: { store: true, maxAge: nodeRuntime.config.httpCacheMaxAge },
    }),
  )
  const results: HttpResult[] = pending.map((call) => {
    try {
      const response = call.result()
      return { status: response.statusCode, body: text(response) }
    } catch {
      return null
    }
  })
  return encodeVerdicts(judgeResponses(effect.cells, effect.requests, results, effect.now, effect.thresholdMmPerHour))
}

function handlersFor(runtime: Runtime<Config>): Handlers<false> {
  const config = runtime.config
  const network = getNetwork({
    chainFamily: 'evm',
    chainSelectorName: config.chainSelectorName,
    isTestnet: config.isTestnet,
  })
  if (!network) throw new Error(`unknown chain ${config.chainSelectorName}`)
  const evm = new EVMClient(network.chainSelector.selector)
  const { coverBook, weatherIndex } = contractAddresses(config)

  const call = (to: Address, data: Hex): Hex => {
    const reply = evm
      .callContract(runtime, { call: encodeCallMsg({ from: zeroAddress, to, data }), blockNumber: LAST_FINALIZED_BLOCK_NUMBER })
      .result()
    return bytesToHex(reply.data)
  }

  return {
    now: () => Math.floor(runtime.now().getTime() / 1000),

    activeCells: () => {
      const data = call(coverBook, encodeFunctionData({ abi: coverBookAbi, functionName: 'activeCells' }))
      return [...decodeFunctionResult({ abi: coverBookAbi, functionName: 'activeCells', data })]
    },

    observe: (effect): Verdict[] => {
      const encoded = runtime.runInNodeMode(observeOnNode, consensusIdenticalAggregation<string>())(effect).result()
      return decodeVerdicts(encoded, effect.cells.length)
    },

    lastTo: (keys) => {
      const lastTo: bigint[] = []
      for (let i = 0; i < keys.length; i += LAST_TO_BATCH) {
        const calls = keys.slice(i, i + LAST_TO_BATCH).map((key) => ({
          target: weatherIndex,
          allowFailure: false,
          callData: encodeFunctionData({ abi: weatherIndexAbi, functionName: 'lastTo', args: [key] }),
        }))
        const data = call(config.multicall3 as Address, encodeFunctionData({ abi: multicall3Abi, functionName: 'aggregate3', args: [calls] }))
        for (const result of decodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', data })) {
          lastTo.push(decodeFunctionResult({ abi: weatherIndexAbi, functionName: 'lastTo', data: result.returnData }))
        }
      }
      return lastTo
    },

    reporterKey: () => privateKeyFromSecret(runtime.getSecret({ id: REPORTER_KEY_SECRET }).result().value),

    deliver: (report: SealedReport, gasLimit: bigint): Delivery => {
      const signed = runtime.report(prepareReportRequest(report.payload)).result()
      const reply = evm
        .writeReport(runtime, { receiver: weatherIndex, report: signed, gasConfig: { gasLimit: gasLimit.toString() } })
        .result()
      const txHash = reply.txHash && reply.txHash.length > 0 ? bytesToHex(reply.txHash) : null
      if (reply.txStatus !== TxStatus.SUCCESS) {
        return { accepted: false, txHash, detail: reply.errorMessage || `transaction status ${reply.txStatus}` }
      }
      // The forwarder's transaction succeeds even when the index rejects the report, so the receiver status
      // decides. It is 1 when `onReport` reverted.
      if (reply.receiverContractExecutionStatus === 1) {
        return { accepted: false, txHash, detail: 'the index rejected the report' }
      }
      return { accepted: true, txHash }
    },

    log: (message) => runtime.log(message),
  }
}

const describe = (summary: RunSummary): string =>
  JSON.stringify({
    outcome: summary.outcome,
    now: summary.now,
    activeCells: summary.activeCells,
    observed: summary.observedKeys.length,
    wet: summary.verdicts.filter((verdict) => verdict === 'wet').length,
    dry: summary.verdicts.filter((verdict) => verdict === 'dry').length,
    unknown: summary.verdicts.filter((verdict) => verdict === 'unknown').length,
    httpRequests: summary.httpRequests,
    reports: summary.reports.map((report) => ({
      issuedAt: report.issuedAt.toString(),
      readings: report.readings,
      wetReadings: report.wetReadings,
      accepted: report.accepted,
      txHash: report.txHash,
    })),
  })

/** Every five minutes: observe the cells with open policies and deliver signed readings to the weather index. */
export const onCronTrigger = (runtime: Runtime<Config>): string => {
  const summary = runOracleSync(settingsFromConfig(runtime.config), handlersFor(runtime))
  const result = describe(summary)
  runtime.log(`oracle run: ${result}`)
  return result
}

export const initWorkflow = (config: Config) => [
  handler(new CronCapability().trigger({ schedule: config.schedule }), onCronTrigger),
]
