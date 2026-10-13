/** Why a read from the indexer failed. Every kind means the same to the app: read the chain instead. */
export type IndexerFailure = 'network' | 'timeout' | 'http' | 'graphql' | 'shape'

export class IndexerError extends Error {
  readonly kind: IndexerFailure

  constructor(kind: IndexerFailure, message: string) {
    super(message)
    this.name = 'IndexerError'
    this.kind = kind
  }
}

export interface IndexerClient {
  readonly url: string
  /**
   * Runs one GraphQL query and hands its `data` to `parse`, which checks the shape and turns it into app types.
   *
   * @throws IndexerError on any failure, including a response `parse` rejects.
   */
  query<T>(document: string, variables: Record<string, unknown>, parse: (data: unknown) => T): Promise<T>
}

export interface IndexerClientOptions {
  fetch?: typeof fetch
  /** A read that takes longer than this is abandoned and the chain is read instead. */
  timeoutMs?: number
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A GraphQL client over `fetch`. No retries: the caller falls back to the chain, which is the retry. */
export function createIndexerClient(url: string, options: IndexerClientOptions = {}): IndexerClient {
  const timeoutMs = options.timeoutMs ?? 6_000
  const send = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init))

  return {
    url,
    async query(document, variables, parse) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let body: unknown
      try {
        const response = await send(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ query: document, variables }),
          signal: controller.signal,
          cache: 'no-store',
        })
        if (!response.ok) throw new IndexerError('http', `the indexer answered ${response.status}`)
        body = await response.json()
      } catch (error) {
        if (error instanceof IndexerError) throw error
        if (controller.signal.aborted) throw new IndexerError('timeout', `the indexer took over ${timeoutMs} ms`)
        throw new IndexerError('network', error instanceof Error ? error.message : 'the indexer could not be reached')
      } finally {
        clearTimeout(timer)
      }

      if (!isObject(body)) throw new IndexerError('shape', 'the indexer answered with something other than JSON')
      if (Array.isArray(body.errors) && body.errors.length > 0) {
        const first: unknown = body.errors[0]
        const message = isObject(first) && typeof first.message === 'string' ? first.message : 'query failed'
        throw new IndexerError('graphql', message)
      }
      if (!isObject(body.data)) throw new IndexerError('shape', 'the indexer answered without data')
      try {
        return parse(body.data)
      } catch (error) {
        if (error instanceof IndexerError) throw error
        throw new IndexerError('shape', error instanceof Error ? error.message : 'unexpected response')
      }
    },
  }
}
