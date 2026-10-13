import type { Context } from '../context'
import { badRequest } from '../http/errors'
import { limitByAddress, limitByIp, requireMethod } from '../http/request'
import { json, type Handler } from '../http/respond'
import { coverRequestSchema } from '../validation'
import { signedQuoteToJson } from './engine'

/** `GET /quote?lat&lon&start&end&rate&holder` */
export function quoteHandler(context: Context): Handler {
  const { limits } = context.settings

  return async (request) => {
    requireMethod(request, 'GET')
    await limitByIp(context, request, 'quote', limits.quotePerIp)

    const params = new URL(request.url).searchParams
    const query: Record<string, string> = {}
    for (const [name, value] of params) {
      if (Object.hasOwn(query, name)) throw badRequest('invalid_request', 'A query parameter is given more than once')
      query[name] = value
    }
    const input = coverRequestSchema.parse(query)
    await limitByAddress(context, 'quote', input.holder, limits.quotePerAddress)

    return json(signedQuoteToJson(await context.quotes.quote(input)))
  }
}
