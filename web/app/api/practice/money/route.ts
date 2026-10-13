import { practice } from '@/lib/server/practice'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Practice mode: practice dollars for an account. */
export function POST(request: Request): Promise<Response> {
  return practice(request, 'drip')
}
