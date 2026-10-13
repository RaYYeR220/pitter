import { isAddressEqual, recoverAddress, type Address, type Hex } from 'viem'
import { eventsOf } from '../chain/events'
import type { Context } from '../context'
import { readJson } from '../http/body'
import { ServiceError, badRequest, conflict, notFound } from '../http/errors'
import { limitByAddress, limitByIp, perWindow, requireMethod } from '../http/request'
import { json, type Handler } from '../http/respond'
import { settlementBatches } from '../relayer/gas'
import type { RelayResult } from '../relayer/relayer'
import type { Json } from '../stores/ledger'
import { enforceLimits } from '../stores/rateLimiter'
import {
  MAX_SETTLE_IDS,
  relayBuySchema,
  relayDepositSchema,
  relaySettleSchema,
  relayTransferSchema,
} from '../validation'
import { assertAuthorization } from './erc3009'
import { relayFailure } from './reverts'
import { NothingToSettle, findSettleable } from './settleable'

export interface RelayHandlers {
  buy: Handler
  deposit: Handler
  transfer: Handler
  settle: Handler
}

async function signedBy(signer: Address, digest: Hex, signature: Hex): Promise<boolean> {
  try {
    return isAddressEqual(await recoverAddress({ hash: digest, signature }), signer)
  } catch {
    return false
  }
}

function assertSucceeded(receipt: RelayResult): void {
  if (receipt.status === 'success') return
  throw new ServiceError(409, 'reverted', 'The transaction was included but failed', {
    details: { transactionHash: receipt.transactionHash },
  })
}

const receiptJson = (receipt: RelayResult) => ({
  transactionHash: receipt.transactionHash,
  blockNumber: receipt.blockNumber.toString(),
})

/**
 * Gasless entry points. Each one takes a user's signature, checks it off chain, and has the relayer submit
 * the matching contract call. The contracts bind every signature to its payee and terms, so the relayer can
 * neither redirect a payment nor change what is bought; these handlers only decide what is worth paying gas
 * for.
 */
export function relayHandlers(context: Context): RelayHandlers {
  const { settings, reader, relayer, calls, core, stores, underwriter } = context
  const { limits, contracts, chainId } = settings
  const { abis } = core

  const limitGlobally = () =>
    enforceLimits(stores.limiter, context.now(), [
      { bucket: 'relay:global', rule: perWindow(context, limits.relayGlobal) },
    ])

  /**
   * Runs `work` at most once per `key`. A repeat of a finished request gets the original answer back; a
   * repeat that arrives while the first is in flight is turned away.
   */
  async function once(key: string, work: () => Promise<Json>): Promise<Response> {
    const claim = await stores.ledger.claim(key, context.now())
    if (!claim.claimed) {
      if (claim.entry.status === 'done') return json(claim.entry.data)
      throw conflict('in_progress', 'This request is already being processed')
    }
    let result: Json
    try {
      result = await work()
    } catch (error) {
      await stores.ledger.release(key)
      const failure = relayFailure(error, abis)
      if (failure instanceof ServiceError && failure.status >= 500) context.logger.warn('relay failed', { key, error })
      throw failure
    }
    try {
      await stores.ledger.save(key, 'done', result, context.now())
    } catch (error) {
      context.logger.error('a relayed transaction could not be recorded', { key, error })
    }
    return json(result)
  }

  async function begin(request: Request): Promise<unknown> {
    requireMethod(request, 'POST')
    await limitByIp(context, request, 'relay', limits.relayPerIp)
    return readJson(request)
  }

  return {
    async buy(request) {
      const input = relayBuySchema.parse(await begin(request))
      const { quote, quoteSig } = input
      const time = context.now()

      if (quote.expiry < BigInt(time)) throw conflict('quote_expired', 'The quote has expired; request a new one')
      const digest = core.signing.quoteDigest(quote, chainId, contracts.coverBook)
      if (!(await signedBy(underwriter.address, digest, quoteSig))) {
        throw badRequest('quote_signature_invalid', 'The quote was not issued by this service')
      }
      await assertAuthorization(
        'ReceiveWithAuthorization',
        await reader.tokenDomain(),
        { from: quote.holder, to: contracts.coverBook, value: quote.premium, nonce: digest },
        input,
        time,
      )
      await limitByAddress(context, 'relay', quote.holder, limits.relayPerAddress)
      await limitGlobally()

      return once(`relay:buy:${digest}`, async () => {
        const receipt = await relayer.execute(calls.buyWithAuthorization(quote, quoteSig, input))
        assertSucceeded(receipt)
        const [bought] = eventsOf(abis.coverBook, contracts.coverBook, receipt.logs, 'PolicyBought')
        return {
          ...receiptJson(receipt),
          policyId: bought ? String(bought.id) : null,
          holder: quote.holder,
          digest,
        }
      })
    },

    async deposit(request) {
      const input = relayDepositSchema.parse(await begin(request))
      const { assets, receiver, nonce } = input

      await assertAuthorization(
        'ReceiveWithAuthorization',
        await reader.tokenDomain(),
        { from: receiver, to: contracts.coverPool, value: assets, nonce },
        input,
        context.now(),
      )
      await limitByAddress(context, 'relay', receiver, limits.relayPerAddress)
      await limitGlobally()

      return once(`relay:deposit:${receiver.toLowerCase()}:${nonce}`, async () => {
        const receipt = await relayer.execute(calls.depositWithAuthorization(assets, receiver, nonce, input))
        assertSucceeded(receipt)
        const [deposited] = eventsOf(abis.coverPool, contracts.coverPool, receipt.logs, 'Deposit')
        return {
          ...receiptJson(receipt),
          receiver,
          assets: assets.toString(),
          shares: deposited ? String(deposited.shares) : null,
        }
      })
    },

    async transfer(request) {
      const input = relayTransferSchema.parse(await begin(request))
      const { from, to, value, nonce } = input

      await assertAuthorization(
        'TransferWithAuthorization',
        await reader.tokenDomain(),
        { from, to, value, nonce },
        input,
        context.now(),
      )
      await limitByAddress(context, 'relay', from, limits.relayPerAddress)
      await limitGlobally()

      return once(`relay:transfer:${from.toLowerCase()}:${nonce}`, async () => {
        const receipt = await relayer.execute(calls.transferWithAuthorization(from, to, value, nonce, input))
        assertSucceeded(receipt)
        return { ...receiptJson(receipt), from, to, value: value.toString() }
      })
    },

    async settle(request) {
      const { ids } = relaySettleSchema.parse(await begin(request))
      await limitGlobally()

      const count = await reader.policyCount()
      if (ids.some((id) => id > count)) throw notFound('No such policy')

      const nothing = () => json({ transactionHash: null, settled: [], skipped: ids.map(String) })
      const settleable = await findSettleable(reader, await reader.policies(ids))
      if (settleable.length === 0) return nothing()
      // One transaction: the first policies that fit its gas; the rest are skipped and can be asked for again.
      const [batch = []] = settlementBatches(settleable, (entry) => entry.mayClose, MAX_SETTLE_IDS)
      const due = batch.map((entry) => entry.policy.id)
      const closing = batch.filter((entry) => entry.mayClose).length

      let receipt: RelayResult
      try {
        receipt = await relayer.execute(calls.settleMany(due, closing), {
          before: async () => {
            const still = await findSettleable(reader, await reader.policies(due))
            if (still.length === 0) throw new NothingToSettle()
          },
        })
      } catch (error) {
        if (error instanceof NothingToSettle) return nothing()
        throw relayFailure(error, abis)
      }
      assertSucceeded(receipt)

      const settled = eventsOf(abis.coverBook, contracts.coverBook, receipt.logs, 'PolicySettled').map((event) => ({
        id: String(event.id),
        paid: String(event.paid),
        settledUntil: Number(event.settledUntil),
        closed: Boolean(event.closed),
      }))
      const done = new Set(due)
      return json({
        ...receiptJson(receipt),
        settled,
        skipped: ids.filter((id) => !done.has(id)).map(String),
      })
    },
  }
}
