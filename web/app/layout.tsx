import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import { Shell } from '@/components/shell'
import { copy } from '@/lib/copy'
import './globals.css'

export const metadata: Metadata = {
  title: { default: copy.product.name, template: `%s · ${copy.product.name}` },
  description: copy.product.description,
  applicationName: copy.product.name,
  appleWebApp: { capable: true, title: copy.product.name, statusBarStyle: 'default' },
  formatDetection: { telephone: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#1f4e8c',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  )
}
