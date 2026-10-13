import { getService, startFailure } from '@/lib/server/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Every service endpoint, mounted under /api: quotes, relays, the keeper, paid cover and the blob store. */
async function handle(request: Request): Promise<Response> {
  let service
  try {
    service = await getService()
  } catch (error) {
    return startFailure(error)
  }
  return service.fetch(request)
}

export { handle as GET, handle as POST, handle as PUT }
