import { health } from '@/lib/server/health'
import { json, startFailure } from '@/lib/server/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Chain, contracts, whether sending works and when the weather was last checked. Nothing secret. */
export async function GET(): Promise<Response> {
  try {
    return json(await health())
  } catch (error) {
    return startFailure(error)
  }
}
