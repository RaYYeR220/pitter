import type { Metadata, Viewport } from 'next'
import { Figtree, Geist_Mono, Outfit } from 'next/font/google'
import type { ReactNode } from 'react'
import { Shell } from '@/components/shell'
import { THEME_BOOT, THEME_COLOR } from '@/components/ui/theme-boot'
import { copy } from '@/lib/copy'
import './globals.css'

const outfit = Outfit({ subsets: ['latin', 'latin-ext'], weight: ['400', '500', '600'], variable: '--outfit' })
const figtree = Figtree({ subsets: ['latin', 'latin-ext'], weight: ['400', '500', '600'], variable: '--figtree' })
const geistMono = Geist_Mono({ subsets: ['latin', 'latin-ext'], weight: ['400', '500'], variable: '--geist-mono' })

export const metadata: Metadata = {
  title: { default: copy.product.name, template: `%s · ${copy.product.name}` },
  description: copy.product.description,
  applicationName: copy.product.name,
  appleWebApp: { capable: true, title: copy.product.name, statusBarStyle: 'black-translucent' },
  formatDetection: { telephone: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: THEME_COLOR.dark,
  colorScheme: 'dark light',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${figtree.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  )
}
