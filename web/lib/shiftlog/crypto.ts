import { createSecp256k1SigningSession, isMeraError } from '@category-labs/mera'
import { toViemAccount } from '@category-labs/mera/viem'
import { sha256, toBytes, type Address, type LocalAccount } from 'viem'

/**
 * The shift log's own namespace of the passkey. The account lives under Mera's default salt; this salt gives
 * an unrelated PRF output from the same passkey, so the key that reads the log has nothing to do with the key
 * that moves money, and each takes its own prompt.
 */
export const SHIFT_LOG_NAMESPACE = 'pitter.shiftlog.v1'

type Bytes = Uint8Array<ArrayBuffer>

const utf8 = (text: string): Bytes => new TextEncoder().encode(text)

/** `sha256("pitter.shiftlog.v1")`: the PRF salt of the shift log. Always 32 bytes, in a fresh allocation. */
export function shiftLogSalt(): Bytes {
  return Uint8Array.from(sha256(toBytes(SHIFT_LOG_NAMESPACE), 'bytes'))
}

const ENCRYPTION_INFO = 'encryption: AES-256-GCM'
const STORAGE_INFO = 'storage identity: secp256k1'
const MAGIC = utf8('PSL1')
const IV_BYTES = 12
const TAG_BYTES = 16
const ASSOCIATED_DATA = utf8(SHIFT_LOG_NAMESPACE)

/** The identity the encrypted log is stored under. It signs blob-store requests and nothing else. */
export interface StorageIdentity {
  /** Owner of the stored blob. Derived from the passkey, and not linked to the account's address. */
  readonly address: Address
  signTypedData: LocalAccount['signTypedData']
  /** Zeroes the key. */
  end(): void
}

/** Everything unlocking the shift log yields. Both halves live in memory only. */
export interface ShiftLogKeys {
  /** AES-256-GCM key. Not extractable: the page can use it, never read it. */
  readonly encryption: CryptoKey
  readonly storage: StorageIdentity
}

export class ShiftLogCryptoError extends Error {
  readonly code: 'cannot_open' | 'unsupported'

  constructor(code: 'cannot_open' | 'unsupported', message: string) {
    super(message)
    this.name = 'ShiftLogCryptoError'
    this.code = code
  }
}

function subtle(): SubtleCrypto {
  const api = globalThis.crypto?.subtle
  if (!api) throw new ShiftLogCryptoError('unsupported', 'Web Crypto is not available here')
  return api
}

const hkdf = (info: string) => ({
  name: 'HKDF',
  hash: 'SHA-256',
  salt: shiftLogSalt(),
  info: utf8(info),
})

/**
 * Derives the shift log's keys from the PRF output of its namespace: HKDF-SHA-256, with one `info` string per
 * key so the two are independent of each other.
 *
 * The same passkey gives the same PRF output on any device, hence the same keys: a second device finds the
 * same stored blob and can decrypt it, with nothing copied between the two.
 *
 * @param prfOutput 32 bytes. Not modified; the caller zeroes them afterwards.
 */
export async function deriveShiftLogKeys(prfOutput: Uint8Array): Promise<ShiftLogKeys> {
  if (prfOutput.length !== 32) throw new RangeError('expected a 32-byte PRF output')
  const material = await subtle().importKey('raw', Uint8Array.from(prfOutput), 'HKDF', false, [
    'deriveKey',
    'deriveBits',
  ])

  const encryption = await subtle().deriveKey(
    hkdf(ENCRYPTION_INFO),
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )

  return { encryption, storage: await deriveStorageIdentity(material) }
}

/**
 * A secp256k1 key from the same material. One time in about 2^128 the 32 bytes are not a valid scalar; the
 * counter in the `info` string then moves on to the next candidate.
 */
async function deriveStorageIdentity(material: CryptoKey): Promise<StorageIdentity> {
  for (let counter = 0; counter < 4; counter++) {
    const bits = new Uint8Array(await subtle().deriveBits(hkdf(`${STORAGE_INFO} #${counter}`), material, 256))
    try {
      const session = createSecp256k1SigningSession({ privateKey: bits })
      const account = toViemAccount(session)
      return { address: account.address, signTypedData: account.signTypedData, end: () => session.end() }
    } catch (error) {
      if (!isMeraError(error) || error.code !== 'INPUT_INVALID') throw error
    } finally {
      bits.fill(0)
    }
  }
  throw new ShiftLogCryptoError('unsupported', 'no storage identity could be derived')
}

/**
 * Encrypts the log for storage: `"PSL1" || iv || ciphertext || tag`, with the namespace as associated data so
 * a blob of another kind can never be read as a shift log.
 *
 * @param iv 12 bytes, random unless a test supplies them. Never reuse one with the same key.
 */
export async function sealLog(key: CryptoKey, plaintext: Uint8Array, iv?: Uint8Array): Promise<Bytes> {
  const nonce = iv ? Uint8Array.from(iv) : crypto.getRandomValues(new Uint8Array(IV_BYTES))
  if (nonce.length !== IV_BYTES) throw new RangeError('expected a 12-byte iv')
  const ciphertext = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: ASSOCIATED_DATA, tagLength: TAG_BYTES * 8 },
      key,
      Uint8Array.from(plaintext),
    ),
  )
  const sealed = new Uint8Array(MAGIC.length + IV_BYTES + ciphertext.length)
  sealed.set(MAGIC, 0)
  sealed.set(nonce, MAGIC.length)
  sealed.set(ciphertext, MAGIC.length + IV_BYTES)
  return sealed
}

/** Decrypts a stored log. Throws `ShiftLogCryptoError` when the bytes are not a log this key can open. */
export async function openLog(key: CryptoKey, sealed: Uint8Array): Promise<Bytes> {
  const header = MAGIC.length + IV_BYTES
  if (sealed.length < header + TAG_BYTES || !MAGIC.every((byte, i) => sealed[i] === byte)) {
    throw new ShiftLogCryptoError('cannot_open', 'not a shift log')
  }
  try {
    return new Uint8Array(
      await subtle().decrypt(
        {
          name: 'AES-GCM',
          iv: Uint8Array.from(sealed.subarray(MAGIC.length, header)),
          additionalData: ASSOCIATED_DATA,
          tagLength: TAG_BYTES * 8,
        },
        key,
        Uint8Array.from(sealed.subarray(header)),
      ),
    )
  } catch {
    throw new ShiftLogCryptoError('cannot_open', 'the shift log cannot be opened with this key')
  }
}
