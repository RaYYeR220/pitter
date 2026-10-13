import { MONAD_MAINNET } from '../config'
import type { Context } from '../context'
import { limitByIp, requireMethod } from '../http/request'
import { json, type Handler } from '../http/respond'
import { requireSecret } from '../http/secret'
import { Keeper } from './keeper'

export const CRON_SECRET_HEADER = 'x-cron-secret'

/** Where the practice-mode weather check sends its tick, below any base path. */
const PRACTICE_TICK_PATH = '/sandbox/tick'

const ATTEMPTS_PER_IP = 30

/**
 * Whether a tick is the practice-mode weather check: addressed to `/sandbox/tick` on a test network with the
 * sandbox on. The web app calls this handler with that path whatever base path the service is mounted under.
 */
function isPracticeCheck(context: Context, request: Request): boolean {
  const { sandbox, chainId } = context.settings
  if (!sandbox.enabled || chainId === MONAD_MAINNET) return false
  return new URL(request.url).pathname.replace(/\/+$/, '').endsWith(PRACTICE_TICK_PATH)
}

/**
 * `POST /cron/tick`, protected by the cron secret. `GET` is accepted as well because hosted schedulers
 * commonly only issue `GET`. The web app also calls it directly for the practice-mode weather check, which
 * reports at once even while no cover is open.
 */
export function cronTickHandler(context: Context, keeper = new Keeper(context)): Handler {
  return async (request) => {
    requireMethod(request, 'POST', 'GET')
    await limitByIp(context, request, 'cron', ATTEMPTS_PER_IP)
    await requireSecret(request, CRON_SECRET_HEADER, context.secrets.cron)
    return json(await keeper.tick({ reportWhenIdle: isPracticeCheck(context, request) }))
  }
}
