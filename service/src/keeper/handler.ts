import type { Context } from '../context'
import { limitByIp, requireMethod } from '../http/request'
import { json, type Handler } from '../http/respond'
import { requireSecret } from '../http/secret'
import { Keeper } from './keeper'

export const CRON_SECRET_HEADER = 'x-cron-secret'

const ATTEMPTS_PER_IP = 30

/**
 * `POST /cron/tick`, protected by the cron secret. `GET` is accepted as well because hosted schedulers
 * commonly only issue `GET`.
 */
export function cronTickHandler(context: Context, keeper = new Keeper(context)): Handler {
  return async (request) => {
    requireMethod(request, 'POST', 'GET')
    await limitByIp(context, request, 'cron', ATTEMPTS_PER_IP)
    await requireSecret(request, CRON_SECRET_HEADER, context.secrets.cron)
    return json(await keeper.tick())
  }
}
