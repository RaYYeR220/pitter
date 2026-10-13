import type { Metadata } from 'next'
import { PoolScreen } from '@/components/screens'
import { copy } from '@/lib/copy'

export const metadata: Metadata = { title: copy.nav.pool }

export default function PoolPage() {
  return <PoolScreen />
}
