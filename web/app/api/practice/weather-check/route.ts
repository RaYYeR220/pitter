import { practice } from '@/lib/server/practice'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Practice mode: one weather check now, instead of waiting for the next scheduled one. */
export function POST(request: Request): Promise<Response> {
  return practice(request, 'tick')
}
