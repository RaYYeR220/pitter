import { keccak256, type Hex, type PrivateKeyAccount } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  BLOB_ISSUED_AT_HEADER,
  BLOB_SIGNATURE_HEADER,
  blobReadTypedData,
  blobWriteTypedData,
} from '../../src/blobs/auth'
import { blobHandler } from '../../src/blobs/handler'
import type { Handler } from '../../src/http/respond'
import { T0 } from '../helpers/fakes'
import { body, harness, type Harness } from '../helpers/harness'

const owner = privateKeyToAccount(generatePrivateKey())
const stranger = privateKeyToAccount(generatePrivateKey())
const ciphertext = new Uint8Array([0, 255, 1, 254, 0, 0, 128, 13, 10, 0xc3, 0x28])

describe('blob store', () => {
  let h: Harness
  let handler: Handler

  beforeEach(() => {
    h = harness()
    handler = h.guarded(blobHandler(h.context))
  })

  interface WriteOptions {
    signer?: PrivateKeyAccount
    path?: string
    name?: string
    issuedAt?: number
    signedName?: string
    signedBytes?: Uint8Array
    chainId?: number
    headers?: Record<string, string>
  }

  async function write(bytes: Uint8Array, options: WriteOptions = {}): Promise<Response> {
    const name = options.name ?? 'shift-log'
    const issuedAt = options.issuedAt ?? h.clock.time
    const signature = await (options.signer ?? owner).signTypedData(
      blobWriteTypedData(options.chainId ?? h.settings.chainId, {
        owner: owner.address,
        name: options.signedName ?? name,
        contentHash: keccak256(options.signedBytes ?? bytes),
        issuedAt: BigInt(issuedAt),
      }),
    )
    return handler(
      new Request(`https://cover.test${options.path ?? `/blobs/${owner.address}/${name}`}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          [BLOB_SIGNATURE_HEADER]: signature,
          [BLOB_ISSUED_AT_HEADER]: String(issuedAt),
          ...options.headers,
        },
        body: bytes,
      }),
    )
  }

  interface ReadOptions {
    signer?: PrivateKeyAccount
    name?: string
    issuedAt?: number
    chainId?: number
    signature?: Hex
  }

  async function read(options: ReadOptions = {}): Promise<Response> {
    const name = options.name ?? 'shift-log'
    const issuedAt = options.issuedAt ?? h.clock.time
    const signature =
      options.signature ??
      (await (options.signer ?? owner).signTypedData(
        blobReadTypedData(options.chainId ?? h.settings.chainId, {
          owner: owner.address,
          name,
          issuedAt: BigInt(issuedAt),
        }),
      ))
    return handler(
      new Request(`https://cover.test/blobs/${owner.address}/${name}`, {
        headers: { [BLOB_SIGNATURE_HEADER]: signature, [BLOB_ISSUED_AT_HEADER]: String(issuedAt) },
      }),
    )
  }

  it('returns exactly the bytes the owner stored', async () => {
    const stored = await write(ciphertext)
    const fetched = await read()

    expect(stored.status).toBe(200)
    expect(await body(stored)).toMatchObject({
      owner: owner.address,
      name: 'shift-log',
      size: ciphertext.byteLength,
      issuedAt: T0,
      contentHash: keccak256(ciphertext),
    })
    expect(fetched.status).toBe(200)
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(ciphertext)
    expect(fetched.headers.get('content-type')).toBe('application/octet-stream')
    expect(fetched.headers.get('x-content-type-options')).toBe('nosniff')
    expect(fetched.headers.get('cache-control')).toBe('private, no-store')
    expect(fetched.headers.get(BLOB_ISSUED_AT_HEADER)).toBe(String(T0))
  })

  it('finds the blob under any spelling of the address', async () => {
    await write(ciphertext, { path: `/blobs/${owner.address.toLowerCase()}/shift-log` })

    expect((await read()).status).toBe(200)
  })

  describe('writes', () => {
    it('refuses a write signed by another address', async () => {
      const response = await write(ciphertext, { signer: stranger })

      expect(response.status).toBe(403)
      expect((await body(response)).error.code).toBe('not_owner')
      expect(await h.stores.blobs.get(owner.address, 'shift-log')).toBeNull()
    })

    it('refuses bytes other than the ones that were signed', async () => {
      const response = await write(new Uint8Array([9, 9, 9]), { signedBytes: ciphertext })

      expect(response.status).toBe(403)
      expect(await h.stores.blobs.get(owner.address, 'shift-log')).toBeNull()
    })

    it('refuses a signature made for another name', async () => {
      expect((await write(ciphertext, { name: 'notes', signedName: 'shift-log' })).status).toBe(403)
    })

    it('refuses a signature made for another network', async () => {
      expect((await write(ciphertext, { chainId: 143 })).status).toBe(403)
    })

    it('refuses a read signature presented for a write', async () => {
      const signature = await owner.signTypedData(
        blobReadTypedData(h.settings.chainId, { owner: owner.address, name: 'shift-log', issuedAt: BigInt(T0) }),
      )

      const response = await write(ciphertext, { headers: { [BLOB_SIGNATURE_HEADER]: signature } })

      expect(response.status).toBe(403)
    })

    it('requires a signature and a timestamp', async () => {
      const unsigned = await handler(
        new Request(`https://cover.test/blobs/${owner.address}/shift-log`, { method: 'PUT', body: ciphertext }),
      )
      const malformed = await write(ciphertext, { headers: { [BLOB_ISSUED_AT_HEADER]: 'yesterday' } })

      expect(unsigned.status).toBe(401)
      expect(malformed.status).toBe(401)
    })

    it('refuses a timestamp far from the current time', async () => {
      expect((await write(ciphertext, { issuedAt: T0 - 301 })).status).toBe(401)
      expect((await write(ciphertext, { issuedAt: T0 + 301 })).status).toBe(401)
      expect((await write(ciphertext, { issuedAt: T0 - 300 })).status).toBe(200)
    })

    it('refuses a replayed write', async () => {
      expect((await write(ciphertext)).status).toBe(200)

      const replay = await write(ciphertext)

      expect(replay.status).toBe(409)
      expect((await body(replay)).error.code).toBe('stale_write')
    })

    it('cannot be rolled back to an older version', async () => {
      const newer = new Uint8Array([1, 2, 3])
      await write(newer, { issuedAt: T0 })

      const rollback = await write(ciphertext, { issuedAt: T0 - 60 })

      expect(rollback.status).toBe(409)
      expect(new Uint8Array(await (await read()).arrayBuffer())).toEqual(newer)
    })

    it('replaces an older version with a newer one', async () => {
      await write(ciphertext, { issuedAt: T0 - 60 })
      const newer = new Uint8Array([4, 5, 6])

      expect((await write(newer, { issuedAt: T0 })).status).toBe(200)
      expect(new Uint8Array(await (await read()).arrayBuffer())).toEqual(newer)
    })

    it('refuses an empty blob and one above the size limit', async () => {
      h = harness({ BLOB_MAX_BYTES: '16' })
      handler = h.guarded(blobHandler(h.context))

      expect((await write(new Uint8Array(0))).status).toBe(400)
      expect((await write(new Uint8Array(17))).status).toBe(413)
      expect((await write(new Uint8Array(16).fill(7))).status).toBe(200)
    })

    it('limits how many blobs an address can keep', async () => {
      h = harness({ BLOB_MAX_PER_ADDRESS: '2' })
      handler = h.guarded(blobHandler(h.context))

      expect((await write(ciphertext, { name: 'one' })).status).toBe(200)
      expect((await write(ciphertext, { name: 'two' })).status).toBe(200)
      const third = await write(ciphertext, { name: 'three' })
      h.clock.time += 1

      expect(third.status).toBe(409)
      expect((await body(third)).error.code).toBe('quota_exceeded')
      expect((await write(ciphertext, { name: 'one' })).status).toBe(200)
    })
  })

  describe('reads', () => {
    beforeEach(async () => {
      await write(ciphertext)
    })

    it('refuses a read signed by another address', async () => {
      const response = await read({ signer: stranger })

      expect(response.status).toBe(403)
      expect(await response.text()).not.toContain(String.fromCharCode(...ciphertext.slice(0, 2)))
    })

    it('refuses a signature made for another name or network', async () => {
      const elsewhere = await owner.signTypedData(
        blobReadTypedData(h.settings.chainId, { owner: owner.address, name: 'notes', issuedAt: BigInt(T0) }),
      )

      expect((await read({ signature: elsewhere })).status).toBe(403)
      expect((await read({ chainId: 143 })).status).toBe(403)
    })

    it('refuses an old read signature', async () => {
      h.clock.time += 301

      expect((await read({ issuedAt: T0 })).status).toBe(401)
    })

    it('answers 404 for a blob that does not exist', async () => {
      expect((await read({ name: 'missing' })).status).toBe(404)
    })
  })

  describe('paths and methods', () => {
    const signed = { [BLOB_SIGNATURE_HEADER]: `0x${'11'.repeat(65)}`, [BLOB_ISSUED_AT_HEADER]: String(T0) }
    const at = (path: string, method = 'GET') =>
      handler(new Request(`https://cover.test${path}`, { method, headers: signed }))

    it.each([
      `/blobs/0x1234/shift-log`,
      `/blobs/${owner.address}/Shift-Log`,
      `/blobs/${owner.address}/..%2Fsecrets`,
      `/blobs/${owner.address}/.env`,
    ])('rejects %s', async (path) => {
      expect((await at(path)).status).toBe(400)
    })

    it.each([`/blobs`, `/blobs/${owner.address}`, `/blobs/${owner.address}/a/b`, `/elsewhere/${owner.address}/a`])(
      'does not know %s',
      async (path) => {
        expect((await at(path)).status).toBe(404)
      },
    )

    it('rejects other methods', async () => {
      const response = await at(`/blobs/${owner.address}/shift-log`, 'DELETE')

      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('GET, PUT')
    })

    it('works under a base path', async () => {
      h = harness({ BASE_PATH: '/api' })
      handler = h.guarded(blobHandler(h.context))

      const response = await write(ciphertext, { path: `/api/blobs/${owner.address}/shift-log` })

      expect(response.status).toBe(200)
      expect((await write(ciphertext, { path: `/blobs/${owner.address}/shift-log`, issuedAt: T0 + 1 })).status).toBe(
        404,
      )
    })
  })

  describe('rate limits', () => {
    it('limits requests per owner once they are authenticated', async () => {
      h = harness({ RATE_BLOB_PER_ADDRESS: '2', RATE_BLOB_PER_IP: '100' })
      handler = h.guarded(blobHandler(h.context))

      for (let i = 0; i < 5; i++) expect((await write(ciphertext, { signer: stranger })).status).toBe(403)
      expect((await write(ciphertext)).status).toBe(200)
      expect((await read()).status).toBe(200)
      expect((await read()).status).toBe(429)
    })

    it('limits requests per IP', async () => {
      h = harness({ RATE_BLOB_PER_IP: '1' })
      handler = h.guarded(blobHandler(h.context))

      expect((await write(ciphertext)).status).toBe(200)
      expect((await read()).status).toBe(429)
    })
  })
})
