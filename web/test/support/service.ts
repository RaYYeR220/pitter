import { createServiceFromEnv, type Service } from '@/lib/server/service-module'
import { generatePrivateKey } from 'viem/accounts'
import { createServiceClient, type ServiceClient } from '@/lib/service/client'

export const TEST_CHAIN_ID = 10143

export interface LocalService {
  service: Service
  client: ServiceClient
  /** Every request the client made, in order. */
  requests: Array<{ method: string; path: string; body: Uint8Array | null }>
  /** Makes the service unreachable, the way a dropped connection is. */
  setOffline(offline: boolean): void
}

/**
 * The real service, in process, with its in-memory stores and throwaway keys. Nothing here reaches a chain:
 * it is for the endpoints that need none, such as the blob store.
 */
export async function localService(now: () => number): Promise<LocalService> {
  const service = await createServiceFromEnv(
    {
      CHAIN_ID: String(TEST_CHAIN_ID),
      RPC_URL: 'http://127.0.0.1:9',
      BASE_PATH: '/api',
      TOKEN_ADDRESS: '0xDe6fb6D4C560C5901f733D53e591F2A0D6EB1438',
      COVER_BOOK_ADDRESS: '0x58d970780565E4C064369AD80eEC2D3581d6d75D',
      COVER_POOL_ADDRESS: '0xfA7e2510EAadB2BB6316Aac81D0D6Aa51a5f4C56',
      WEATHER_INDEX_ADDRESS: '0x171CFCBAA60C9AfD267474773122293a67FbeD94',
      UNDERWRITER_PRIVATE_KEY: generatePrivateKey(),
      RELAYER_PRIVATE_KEY: generatePrivateKey(),
      RATE_BLOB_PER_IP: '10000',
      RATE_BLOB_PER_ADDRESS: '10000',
    },
    { now, logger: { info() {}, warn() {}, error() {} } },
  )

  const requests: LocalService['requests'] = []
  let offline = false

  const client = createServiceClient({
    baseUrl: 'http://cover.test/api',
    fetch: async (input, init) => {
      if (offline) throw new TypeError('fetch failed')
      const request = new Request(input as string, init)
      const body = init?.body instanceof Uint8Array ? init.body : null
      requests.push({ method: request.method, path: new URL(request.url).pathname, body })
      return service.fetch(request)
    },
  })

  return {
    service,
    client,
    requests,
    setOffline(value) {
      offline = value
    },
  }
}
