import { decodeErrorResult, type Abi } from 'viem'
import { eventsOf } from '../chain/events'
import { MONAD_MAINNET } from '../config'
import type { Context } from '../context'
import { readJson } from '../http/body'
import { ServiceError, forbidden } from '../http/errors'
import { limitByIp, requireMethod } from '../http/request'
import { json, type Handler } from '../http/respond'
import { requireSecret } from '../http/secret'
import { relayFailure } from '../relay/reverts'
import { SimulationReverted } from '../relayer/errors'
import { dripSchema, stormSchema } from '../validation'
import { readStorm, writeStorm } from './storm'

export const SANDBOX_SECRET_HEADER = 'x-sandbox-secret'

export interface SandboxHandlers {
  drip: Handler
  storm: Handler
}

/**
 * Test-network conveniences: a faucet for the test dollar and the storm switch of the simulator cell. They
 * are off unless enabled, need the sandbox secret, and never run on Monad mainnet whatever the settings say.
 */
export function sandboxHandlers(context: Context): SandboxHandlers {
  const { settings, relayer, calls, core, stores } = context

  async function enter(request: Request): Promise<void> {
    if (!settings.sandbox.enabled || settings.chainId === MONAD_MAINNET || settings.sandbox.simulatorKey === null) {
      throw forbidden('sandbox_unavailable', 'The sandbox is not available here')
    }
    await limitByIp(context, request, 'sandbox', settings.limits.sandboxPerIp)
    await requireSecret(request, SANDBOX_SECRET_HEADER, context.secrets.sandbox)
  }

  function dripLimit(error: unknown): ServiceError | null {
    if (!(error instanceof SimulationReverted) || !error.data) return null
    try {
      const errors = core.abis.token.filter((item) => item.type === 'error') as Abi
      const decoded = decodeErrorResult({ abi: errors, data: error.data })
      if (decoded.errorName !== 'DripLimited') return null
      const availableAt = Number(decoded.args?.[1] ?? 0)
      return new ServiceError(429, 'drip_limited', 'This address has already received test dollars today', {
        details: { availableAt },
      })
    } catch {
      return null
    }
  }

  return {
    async drip(request) {
      requireMethod(request, 'POST')
      await enter(request)
      const { address } = dripSchema.parse(await readJson(request))

      try {
        const receipt = await relayer.execute(calls.drip(address))
        if (receipt.status !== 'success') {
          throw new ServiceError(409, 'reverted', 'The transaction was included but failed', {
            details: { transactionHash: receipt.transactionHash },
          })
        }
        const [dripped] = eventsOf(core.abis.token, settings.contracts.token, receipt.logs, 'Dripped')
        return json({
          transactionHash: receipt.transactionHash,
          address,
          amount: dripped ? String(dripped.amount) : null,
          simulated: true,
        })
      } catch (error) {
        throw dripLimit(error) ?? relayFailure(error, core.abis)
      }
    },

    async storm(request) {
      requireMethod(request, 'POST', 'GET')
      await enter(request)

      const storm =
        request.method === 'GET'
          ? await readStorm(stores.state)
          : await writeStorm(stores.state, stormSchema.parse(await readJson(request)).wet, context.now())
      return json({ simulatorKey: settings.sandbox.simulatorKey!.toString(), ...storm, simulated: true })
    },
  }
}
