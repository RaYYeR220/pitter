import { createCipheriv, hkdfSync } from 'node:crypto'
import { sha256, toBytes, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { deriveAccountKey } from '@/lib/account'
import {
  SHIFT_LOG_NAMESPACE,
  ShiftLogCryptoError,
  deriveShiftLogKeys,
  openLog,
  sealLog,
  shiftLogSalt,
} from '@/lib/shiftlog'
import { MERA_DEFAULT_SALT, fakeAuthenticator } from './support/passkeys'

const PRF = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)
const IV = Uint8Array.from({ length: 12 }, (_, i) => i + 1)
const text = (value: string) => new TextEncoder().encode(value)
const read = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe('the shift log namespace', () => {
  it('is sha256 of its name, and is not the account salt', () => {
    expect(SHIFT_LOG_NAMESPACE).toBe('pitter.shiftlog.v1')
    expect(toHex(shiftLogSalt())).toBe(sha256(toBytes('pitter.shiftlog.v1')))
    expect(toHex(shiftLogSalt())).toBe('0x8ae88c8611354366beb42267e201c3fc27e30e0359e75dcd1ac58188c755489c')
    expect(shiftLogSalt()).toHaveLength(32)
    expect(toHex(shiftLogSalt())).not.toBe(toHex(MERA_DEFAULT_SALT))
  })

  it('hands out a fresh copy each time', () => {
    const first = shiftLogSalt()
    first.fill(0)
    expect(shiftLogSalt().some((byte) => byte !== 0)).toBe(true)
  })
})

describe('deriveShiftLogKeys', () => {
  it('derives the same keys from the same PRF output, every time', async () => {
    const a = await deriveShiftLogKeys(PRF)
    const b = await deriveShiftLogKeys(Uint8Array.from(PRF))
    expect(a.storage.address).toBe(b.storage.address)

    const sealedByA = await sealLog(a.encryption, text('route of the first device'))
    expect(read(await openLog(b.encryption, sealedByA))).toBe('route of the first device')
  })

  it('produces identical ciphertext for the same key, iv and plaintext', async () => {
    const a = await deriveShiftLogKeys(PRF)
    const b = await deriveShiftLogKeys(PRF)
    const first = await sealLog(a.encryption, text('52.22977, 21.01178'), IV)
    const second = await sealLog(b.encryption, text('52.22977, 21.01178'), IV)
    expect(toHex(first)).toBe(toHex(second))
    expect(read(first.subarray(0, 4))).toBe('PSL1')
    expect(toHex(first.subarray(4, 16))).toBe(toHex(IV))
    expect(first).toHaveLength(4 + 12 + 18 + 16)
  })

  it('matches a known vector', async () => {
    const keys = await deriveShiftLogKeys(PRF)
    expect(keys.storage.address).toBe('0x8d45A6F24b592e7ded5386976b7AdadA6d88f98C')
    expect(toHex(await sealLog(keys.encryption, text('pitter'), IV))).toBe(
      '0x50534c310102030405060708090a0b0cfc22290fc01ea9bdbb427b3b3e8604a1a25baac257b2',
    )
  })

  it('is HKDF-SHA-256 over the PRF output, as an independent implementation computes it', async () => {
    const salt = shiftLogSalt()
    const aesKey = Buffer.from(hkdfSync('sha256', PRF, salt, 'encryption: AES-256-GCM', 32))
    const cipher = createCipheriv('aes-256-gcm', aesKey, IV)
    cipher.setAAD(Buffer.from(SHIFT_LOG_NAMESPACE))
    const expected = Buffer.concat([
      Buffer.from('PSL1'),
      IV,
      cipher.update('exact route'),
      cipher.final(),
      cipher.getAuthTag(),
    ])

    const keys = await deriveShiftLogKeys(PRF)
    expect(toHex(await sealLog(keys.encryption, text('exact route'), IV))).toBe(toHex(expected))

    const identity = Buffer.from(hkdfSync('sha256', PRF, salt, 'storage identity: secp256k1 #0', 32))
    expect(keys.storage.address).toBe(privateKeyToAccount(toHex(identity)).address)
  })

  it('uses a random iv unless told otherwise, so equal logs do not look equal in storage', async () => {
    const { encryption } = await deriveShiftLogKeys(PRF)
    const first = await sealLog(encryption, text('same'))
    const second = await sealLog(encryption, text('same'))
    expect(toHex(first)).not.toBe(toHex(second))
    expect(read(await openLog(encryption, first))).toBe('same')
    expect(read(await openLog(encryption, second))).toBe('same')
  })

  it('gives an unrelated key for a different salt of the same passkey', async () => {
    const authenticator = fakeAuthenticator()
    const { credential, prfOutput: accountPrf } = await authenticator.create({ label: 'test' })
    const { prfOutput: logPrf } = await authenticator.evaluate({ credential, prfSalt: shiftLogSalt() })
    const { prfOutput: logPrfAgain } = await authenticator.evaluate({ credential, prfSalt: shiftLogSalt() })
    expect(toHex(logPrf)).toBe(toHex(logPrfAgain))
    expect(toHex(logPrf)).not.toBe(toHex(accountPrf))

    const fromLogSalt = await deriveShiftLogKeys(logPrf)
    const fromAccountSalt = await deriveShiftLogKeys(accountPrf)
    expect(fromLogSalt.storage.address).not.toBe(fromAccountSalt.storage.address)

    const sealed = await sealLog(fromLogSalt.encryption, text('private'))
    await expect(openLog(fromAccountSalt.encryption, sealed)).rejects.toMatchObject({ code: 'cannot_open' })

    const account = privateKeyToAccount(toHex(deriveAccountKey(accountPrf)))
    expect(fromLogSalt.storage.address).not.toBe(account.address)
    expect(fromAccountSalt.storage.address).not.toBe(account.address)
  })

  it('gives an unrelated key for another passkey', async () => {
    const mine = await deriveShiftLogKeys(PRF)
    const theirs = await deriveShiftLogKeys(Uint8Array.from(PRF, (byte) => byte ^ 1))
    expect(theirs.storage.address).not.toBe(mine.storage.address)
    await expect(openLog(theirs.encryption, await sealLog(mine.encryption, text('x')))).rejects.toBeInstanceOf(
      ShiftLogCryptoError,
    )
  })

  it('keeps the encryption key out of reach of the page', async () => {
    const { encryption } = await deriveShiftLogKeys(PRF)
    expect(encryption.extractable).toBe(false)
    expect(encryption.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
    expect([...encryption.usages].sort()).toEqual(['decrypt', 'encrypt'])
    await expect(crypto.subtle.exportKey('raw', encryption)).rejects.toThrow()
    await expect(crypto.subtle.exportKey('jwk', encryption)).rejects.toThrow()
  })

  it('does not modify the PRF output it is given', async () => {
    const prf = Uint8Array.from(PRF)
    await deriveShiftLogKeys(prf)
    expect(toHex(prf)).toBe(toHex(PRF))
  })

  it('refuses key material of the wrong length', async () => {
    await expect(deriveShiftLogKeys(new Uint8Array(31))).rejects.toThrow(RangeError)
  })

  it('ends the storage identity on request', async () => {
    const { storage } = await deriveShiftLogKeys(PRF)
    storage.end()
    await expect(
      storage.signTypedData({
        domain: { name: 'x' },
        types: { T: [{ name: 'a', type: 'uint256' }] },
        primaryType: 'T',
        message: { a: 1n },
      }),
    ).rejects.toMatchObject({ code: 'SESSION_ENDED' })
  })
})

describe('sealLog and openLog', () => {
  it('reject anything that was changed in storage', async () => {
    const { encryption } = await deriveShiftLogKeys(PRF)
    const sealed = await sealLog(encryption, text('route'))
    for (const index of [4, 16, sealed.length - 1]) {
      const tampered = Uint8Array.from(sealed)
      tampered[index]! ^= 1
      await expect(openLog(encryption, tampered)).rejects.toMatchObject({ code: 'cannot_open' })
    }
  })

  it('reject bytes that are not a shift log', async () => {
    const { encryption } = await deriveShiftLogKeys(PRF)
    const sealed = await sealLog(encryption, text('route'))
    const renamed = Uint8Array.from(sealed)
    renamed.set(text('XXXX'), 0)
    await expect(openLog(encryption, renamed)).rejects.toMatchObject({ code: 'cannot_open' })
    await expect(openLog(encryption, sealed.subarray(0, 20))).rejects.toMatchObject({ code: 'cannot_open' })
    await expect(openLog(encryption, new Uint8Array(0))).rejects.toMatchObject({ code: 'cannot_open' })
  })

  it('bind the ciphertext to the shift log namespace', async () => {
    const { encryption } = await deriveShiftLogKeys(PRF)
    const sealed = await sealLog(encryption, text('route'), IV)
    await expect(
      crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: IV, additionalData: text('another.namespace') },
        encryption,
        sealed.subarray(16),
      ),
    ).rejects.toThrow()
    await expect(
      crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: IV, additionalData: text(SHIFT_LOG_NAMESPACE) },
        encryption,
        sealed.subarray(16),
      ),
    ).resolves.toBeInstanceOf(ArrayBuffer)
  })

  it('refuse an iv of the wrong length', async () => {
    const { encryption } = await deriveShiftLogKeys(PRF)
    await expect(sealLog(encryption, text('x'), new Uint8Array(16))).rejects.toThrow(RangeError)
  })

  it('round-trip an empty log and a large one', async () => {
    const { encryption } = await deriveShiftLogKeys(PRF)
    expect(await openLog(encryption, await sealLog(encryption, new Uint8Array(0)))).toHaveLength(0)
    const large = crypto.getRandomValues(new Uint8Array(60_000))
    expect(toHex(await openLog(encryption, await sealLog(encryption, large)))).toBe(toHex(large))
  })
})
