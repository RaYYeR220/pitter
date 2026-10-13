import type { Metadata } from 'next'
import { CoverScreen } from '@/components/screens'
import { copy } from '@/lib/copy'

export const metadata: Metadata = { title: copy.nav.cover }

export default function CoverPage() {
  return <CoverScreen />
}
