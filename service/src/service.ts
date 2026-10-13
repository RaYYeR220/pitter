import type { Address } from 'viem'
import { BLOBS_PATH, blobHandler } from './blobs/handler'
import { buildContext, type ServiceDeps } from './context'
import { notFound } from './http/errors'
import { errorResponse, guard, type Handler } from './http/respond'
import { cronTickHandler } from './keeper/handler'
import { quoteHandler } from './quote/handler'
import { relayHandlers } from './relay/handlers'
import { sandboxHandlers } from './sandbox/handlers'
import { COVER_PATH, coverHandler } from './x402/cover'

export interface Route {
  path: string
  methods: readonly string[]
  /** Whether the route also answers for paths below it. */
  prefix: boolean
  handler: Handler
}

export interface Service {
  /** Routes a request by its path, below the configured base path. Mount it on a catch-all route. */
  fetch: Handler
  /** Every handler on its own, for a host that does the routing itself. */
  handlers: {
    quote: Handler
    relayBuy: Handler
    relayDeposit: Handler
    relayTransfer: Handler
    relaySettle: Handler
    cronTick: Handler
    cover: Handler
    blobs: Handler
    sandboxDrip: Handler
    sandboxStorm: Handler
  }
  routes: readonly Route[]
  /** The account that pays gas for relayed transactions and receives paid-cover payments. */
  relayerAddress: Address
}

/**
 * Builds the service from its dependencies. Every handler takes a Fetch API `Request` and returns a
 * `Response`, never throws, and reaches the outside world only through what is passed in here.
 */
export function createService(deps: ServiceDeps): Service {
  const context = buildContext(deps)
  const relay = relayHandlers(context)
  const sandbox = sandboxHandlers(context)
  const guarded = (name: string, handler: Handler) => guard(name, handler, context.logger)

  const handlers: Service['handlers'] = {
    quote: guarded('quote', quoteHandler(context)),
    relayBuy: guarded('relay/buy', relay.buy),
    relayDeposit: guarded('relay/deposit', relay.deposit),
    relayTransfer: guarded('relay/transfer', relay.transfer),
    relaySettle: guarded('relay/settle', relay.settle),
    cronTick: guarded('cron/tick', cronTickHandler(context)),
    cover: guarded('v1/cover', coverHandler(context)),
    blobs: guarded('blobs', blobHandler(context)),
    sandboxDrip: guarded('sandbox/drip', sandbox.drip),
    sandboxStorm: guarded('sandbox/storm', sandbox.storm),
  }

  const route = (path: string, methods: string[], handler: Handler, prefix = false): Route => ({
    path,
    methods,
    prefix,
    handler,
  })
  const routes: Route[] = [
    route('/quote', ['GET'], handlers.quote),
    route('/relay/buy', ['POST'], handlers.relayBuy),
    route('/relay/deposit', ['POST'], handlers.relayDeposit),
    route('/relay/transfer', ['POST'], handlers.relayTransfer),
    route('/relay/settle', ['POST'], handlers.relaySettle),
    route('/cron/tick', ['POST', 'GET'], handlers.cronTick),
    route(COVER_PATH, ['POST'], handlers.cover),
    route(BLOBS_PATH, ['GET', 'PUT'], handlers.blobs, true),
    route('/sandbox/drip', ['POST'], handlers.sandboxDrip),
    route('/sandbox/storm', ['POST', 'GET'], handlers.sandboxStorm),
  ]

  const { basePath } = context.settings
  const fetch: Handler = async (request) => {
    const { pathname } = new URL(request.url)
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return errorResponse(notFound())
    const path = pathname.slice(basePath.length).replace(/\/+$/, '')
    const match = routes.find((entry) => path === entry.path || (entry.prefix && path.startsWith(`${entry.path}/`)))
    return match ? match.handler(request) : errorResponse(notFound())
  }

  return { fetch, handlers, routes, relayerAddress: context.relayer.address }
}
