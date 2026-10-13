import { practice } from '@/lib/server/practice'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Practice mode: the rain switch of the simulator area. */
export function GET(request: Request): Promise<Response> {
  return practice(request, 'storm')
}

export function POST(request: Request): Promise<Response> {
  return practice(request, 'storm')
}
