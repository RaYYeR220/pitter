import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'

const production = process.env.NODE_ENV === 'production'

/** Origins the browser reads chain state from: the public Monad nodes, plus a configured one. */
function nodeOrigins(): string[] {
  const origins = ['https://rpc.monad.xyz', 'https://testnet-rpc.monad.xyz']
  const configured = process.env.NEXT_PUBLIC_RPC_URL
  if (configured) {
    try {
      origins.push(new URL(configured).origin)
    } catch {
      throw new Error('NEXT_PUBLIC_RPC_URL is not a URL')
    }
  }
  return [...new Set(origins)]
}

/**
 * The signing key of a signed-in account lives in page memory, so no script from another origin may ever run
 * here: scripts, styles and frames are same-origin only, and the page can talk to this host and the chain
 * nodes, nothing else.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self' ${nodeOrigins().join(' ')}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'geolocation=(self), publickey-credentials-get=(self), publickey-credentials-create=(self)' },
  ...(production ? [{ key: 'Content-Security-Policy', value: contentSecurityPolicy }] : []),
]

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@cover/core', '@cover/service'],
  outputFileTracingRoot: fileURLToPath(new URL('..', import.meta.url)),
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default config
