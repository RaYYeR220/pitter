import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresNonceStore } from '../../src/postgres/nonces'
import { PostgresBlobStore, PostgresLedger, PostgresRateLimiter, PostgresStateStore } from '../../src/postgres/stores'
import { MemoryNonceStore, type NonceStore } from '../../src/relayer/nonces'
import { MemoryBlobStore, type BlobStore } from '../../src/stores/blobs'
import { MemoryLedger, type Ledger } from '../../src/stores/ledger'
import { MemoryRateLimiter, type RateLimiter } from '../../src/stores/rateLimiter'
import { MemoryStateStore, type StateStore } from '../../src/stores/state'
import { T0 } from '../helpers/fakes'
import { testDatabase, type TestDatabase } from '../helpers/postgres'

interface Stores {
  nonces: NonceStore
  limiter: RateLimiter
  ledger: Ledger
  state: StateStore
  blobs: BlobStore
}

let database: TestDatabase

beforeAll(async () => {
  database = await testDatabase()
})

afterAll(async () => {
  await database.close()
})

const implementations: Array<[name: string, make: () => Stores]> = [
  [
    'memory',
    () => ({
      nonces: new MemoryNonceStore(),
      limiter: new MemoryRateLimiter(),
      ledger: new MemoryLedger(),
      state: new MemoryStateStore(),
      blobs: new MemoryBlobStore(),
    }),
  ],
  [
    'postgres',
    () => ({
      nonces: new PostgresNonceStore(database.db),
      limiter: new PostgresRateLimiter(database.db),
      ledger: new PostgresLedger(database.db),
      state: new PostgresStateStore(database.db),
      blobs: new PostgresBlobStore(database.db),
    }),
  ],
]

const unique = (prefix: string) => `${prefix}:${crypto.randomUUID()}`
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe.each(implementations)('%s stores', (_name, make) => {
  let stores: Stores

  beforeAll(() => {
    stores = make()
  })

  describe('rate limiter', () => {
    const rule = { limit: 3, windowSeconds: 60 }

    it('allows the limit and refuses the next request', async () => {
      const bucket = unique('rate')

      const decisions = []
      for (let i = 0; i < 4; i++) decisions.push(await stores.limiter.hit(bucket, rule, T0 + 10))

      expect(decisions.map((decision) => decision.allowed)).toEqual([true, true, true, false])
      expect(decisions[3]!.retryAfterSeconds).toBe(50)
    })

    it('starts counting again in the next window', async () => {
      const bucket = unique('rate')
      for (let i = 0; i < 4; i++) await stores.limiter.hit(bucket, rule, T0)

      expect((await stores.limiter.hit(bucket, rule, T0 + 60)).allowed).toBe(true)
    })

    it('counts buckets separately', async () => {
      const first = unique('rate')
      for (let i = 0; i < 4; i++) await stores.limiter.hit(first, rule, T0)

      expect((await stores.limiter.hit(unique('rate'), rule, T0)).allowed).toBe(true)
    })

    it('counts concurrent requests exactly', async () => {
      const bucket = unique('rate')

      const decisions = await Promise.all(
        Array.from({ length: 20 }, () => stores.limiter.hit(bucket, { limit: 7, windowSeconds: 60 }, T0)),
      )

      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(7)
    })
  })

  describe('ledger', () => {
    it('lets exactly one of many concurrent callers claim a key', async () => {
      const key = unique('ledger')

      const claims = await Promise.all(Array.from({ length: 12 }, () => stores.ledger.claim(key, T0)))

      expect(claims.filter((claim) => claim.claimed)).toHaveLength(1)
      const loser = claims.find((claim) => !claim.claimed)!
      expect(loser.claimed === false && loser.entry.status).toBe('processing')
    })

    it('hands back the result of finished work', async () => {
      const key = unique('ledger')
      await stores.ledger.claim(key, T0)
      await stores.ledger.save(key, 'done', { policyId: '7', nested: [1, 'two', null] }, T0 + 1)

      const again = await stores.ledger.claim(key, T0 + 2)

      expect(again).toEqual({
        claimed: false,
        entry: { status: 'done', data: { policyId: '7', nested: [1, 'two', null] }, updatedAt: T0 + 1 },
      })
    })

    it('forgets released work that recorded nothing', async () => {
      const key = unique('ledger')
      await stores.ledger.claim(key, T0)
      await stores.ledger.release(key)

      expect(await stores.ledger.claim(key, T0 + 1)).toEqual({ claimed: true, resumed: null })
    })

    it('lets settled work be resumed by exactly one caller', async () => {
      const key = unique('ledger')
      await stores.ledger.claim(key, T0)
      await stores.ledger.save(key, 'settled', { transaction: '0xabc' }, T0)

      const claims = await Promise.all(Array.from({ length: 8 }, () => stores.ledger.claim(key, T0 + 1)))

      const winners = claims.filter((claim) => claim.claimed)
      expect(winners).toEqual([{ claimed: true, resumed: { transaction: '0xabc' } }])
    })

    it('keeps the claim while recording progress', async () => {
      const key = unique('ledger')
      await stores.ledger.claim(key, T0)
      await stores.ledger.checkpoint(key, { transaction: '0xabc' }, T0)

      const other = await stores.ledger.claim(key, T0 + 1)

      expect(other.claimed).toBe(false)
      expect(other.claimed === false && other.entry).toMatchObject({
        status: 'processing',
        data: { transaction: '0xabc' },
      })
    })

    it('never forgets recorded progress on release', async () => {
      const key = unique('ledger')
      await stores.ledger.claim(key, T0)
      await stores.ledger.checkpoint(key, { transaction: '0xabc' }, T0)
      await stores.ledger.release(key)

      expect(await stores.ledger.claim(key, T0 + 1)).toEqual({ claimed: true, resumed: { transaction: '0xabc' } })
    })

    it('leaves finished work alone on release', async () => {
      const key = unique('ledger')
      await stores.ledger.claim(key, T0)
      await stores.ledger.save(key, 'done', 'ok', T0)
      await stores.ledger.release(key)

      expect((await stores.ledger.claim(key, T0)).claimed).toBe(false)
    })
  })

  describe('state', () => {
    it('returns null for a key that was never set', async () => {
      expect(await stores.state.get(unique('state'))).toBeNull()
    })

    it('stores and replaces values', async () => {
      const key = unique('state')

      await stores.state.set(key, { wet: true, since: T0 })
      await stores.state.set(key, { wet: false, since: T0 + 5 })

      expect(await stores.state.get(key)).toEqual({ wet: false, since: T0 + 5 })
    })

    it('keeps strings as strings', async () => {
      const key = unique('state')

      await stores.state.set(key, '42')

      expect(await stores.state.get(key)).toBe('42')
    })
  })

  describe('blobs', () => {
    const bytes = new Uint8Array([0, 255, 7, 0, 128])
    const owner = () => privateKeyToAddress(generatePrivateKey())

    it('returns the stored bytes unchanged', async () => {
      const who = owner()

      expect(await stores.blobs.put(who, 'log', { bytes, issuedAt: T0 }, 4)).toBe('stored')

      const blob = await stores.blobs.get(who, 'log')
      expect(blob?.issuedAt).toBe(T0)
      expect(Array.from(blob!.bytes)).toEqual(Array.from(bytes))
    })

    it('returns null for a blob that does not exist', async () => {
      expect(await stores.blobs.get(owner(), 'log')).toBeNull()
    })

    it('only replaces a blob with a newer version', async () => {
      const who = owner()
      await stores.blobs.put(who, 'log', { bytes, issuedAt: T0 }, 4)

      expect(await stores.blobs.put(who, 'log', { bytes, issuedAt: T0 }, 4)).toBe('stale')
      expect(await stores.blobs.put(who, 'log', { bytes, issuedAt: T0 - 1 }, 4)).toBe('stale')
      expect(await stores.blobs.put(who, 'log', { bytes: new Uint8Array([1]), issuedAt: T0 + 1 }, 4)).toBe('stored')
      expect(Array.from((await stores.blobs.get(who, 'log'))!.bytes)).toEqual([1])
    })

    it('caps the number of blobs per owner, also under concurrent writes', async () => {
      const who = owner()

      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => stores.blobs.put(who, `log-${i}`, { bytes, issuedAt: T0 }, 3)),
      )

      expect(results.filter((result) => result === 'stored')).toHaveLength(3)
      expect(results.filter((result) => result === 'quota')).toHaveLength(3)
    })

    it('keeps owners apart', async () => {
      const first = owner()
      const second = owner()
      await stores.blobs.put(first, 'log', { bytes, issuedAt: T0 }, 1)

      expect(await stores.blobs.get(second, 'log')).toBeNull()
      expect(await stores.blobs.put(second, 'log', { bytes, issuedAt: T0 }, 1)).toBe('stored')
    })
  })

  describe('nonces', () => {
    const signer = () => ({ chainId: 10143, address: privateKeyToAddress(generatePrivateKey()) })

    it('reads the chain once and then counts on its own', async () => {
      const who = signer()
      let reads = 0
      const chain = async () => {
        reads++
        return 5
      }
      const used: number[] = []

      for (let i = 0; i < 3; i++) {
        await stores.nonces.withNonce(who, chain, async (lease) => {
          used.push(lease.nonce)
          lease.consume()
        })
      }

      expect(used).toEqual([5, 6, 7])
      expect(reads).toBe(1)
    })

    it('gives concurrent tasks consecutive nonces and never runs two at once', async () => {
      const who = signer()
      const used: number[] = []
      let running = 0
      let overlap = 0

      await Promise.all(
        Array.from({ length: 10 }, () =>
          stores.nonces.withNonce(
            who,
            async () => 100,
            async (lease) => {
              overlap = Math.max(overlap, ++running)
              await pause(3)
              used.push(lease.nonce)
              lease.consume()
              running--
            },
          ),
        ),
      )

      expect(used.sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, i) => 100 + i))
      expect(overlap).toBe(1)
    })

    it('keeps the nonce when a task does not use it', async () => {
      const who = signer()
      const chain = async () => 9

      await expect(
        stores.nonces.withNonce(who, chain, async () => {
          throw new Error('would revert')
        }),
      ).rejects.toThrow('would revert')
      const next = await stores.nonces.withNonce(who, chain, async (lease) => lease.nonce)

      expect(next).toBe(9)
    })

    it('goes back to the chain after an unknown outcome', async () => {
      const who = signer()
      let chainNonce = 3

      await stores.nonces
        .withNonce(
          who,
          async () => chainNonce,
          async (lease) => {
            lease.invalidate()
            throw new Error('no receipt')
          },
        )
        .catch(() => undefined)
      chainNonce = 4
      const next = await stores.nonces.withNonce(
        who,
        async () => chainNonce,
        async (lease) => lease.nonce,
      )

      expect(next).toBe(4)
    })

    it('continues from a refreshed nonce', async () => {
      const who = signer()
      let chainNonce = 1

      const used = await stores.nonces.withNonce(
        who,
        async () => chainNonce,
        async (lease) => {
          chainNonce = 8
          const refreshed = await lease.refresh()
          lease.consume()
          return refreshed
        },
      )
      const next = await stores.nonces.withNonce(
        who,
        async () => chainNonce,
        async (lease) => lease.nonce,
      )

      expect(used).toBe(8)
      expect(next).toBe(9)
    })

    it('keeps signers and chains apart', async () => {
      const who = signer()
      const chain = async () => 0

      await stores.nonces.withNonce(who, chain, async (lease) => lease.consume())
      const sameSigner = await stores.nonces.withNonce(who, chain, async (lease) => lease.nonce)
      const otherChain = await stores.nonces.withNonce({ ...who, chainId: 143 }, chain, async (lease) => lease.nonce)

      expect(sameSigner).toBe(1)
      expect(otherChain).toBe(0)
    })

    it('frees the lock when reading the chain fails', async () => {
      const who = signer()

      await expect(
        stores.nonces.withNonce(
          who,
          async () => {
            throw new Error('rpc down')
          },
          async () => undefined,
        ),
      ).rejects.toThrow('rpc down')

      expect(
        await stores.nonces.withNonce(
          who,
          async () => 2,
          async (lease) => lease.nonce,
        ),
      ).toBe(2)
    })
  })
})

describe('postgres nonce store', () => {
  it('gives up with a busy signal when the lock cannot be had in time', async (context) => {
    if (!database.concurrent) return context.skip()
    const who = { chainId: 10143, address: privateKeyToAddress(generatePrivateKey()) }
    const patient = new PostgresNonceStore(database.db)
    const impatient = new PostgresNonceStore(database.db, { lockTimeoutMs: 50 })

    const holding = patient.withNonce(
      who,
      async () => 0,
      async () => pause(400),
    )
    await pause(100)

    await expect(
      impatient.withNonce(
        who,
        async () => 0,
        async () => undefined,
      ),
    ).rejects.toThrow(/busy/)
    await holding
  })

  it('serialises leases taken through separate stores', async () => {
    const who = { chainId: 10143, address: privateKeyToAddress(generatePrivateKey()) }
    const instances = Array.from({ length: 4 }, () => new PostgresNonceStore(database.db))
    const used: number[] = []
    let running = 0
    let overlap = 0

    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        instances[i % instances.length]!.withNonce(
          who,
          async () => 0,
          async (lease) => {
            overlap = Math.max(overlap, ++running)
            await pause(2)
            used.push(lease.nonce)
            lease.consume()
            running--
          },
        ),
      ),
    )

    expect(used.sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i))
    expect(overlap).toBe(1)
  })
})
