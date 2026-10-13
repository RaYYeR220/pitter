import type { MetadataRoute } from 'next'
import { copy } from '@/lib/copy'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: copy.product.name,
    short_name: copy.product.name,
    description: copy.product.description,
    start_url: '/app',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f4f4f2',
    theme_color: '#1f4e8c',
    icons: [
      { src: '/icons/192', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/512', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/512?maskable', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  }
}
