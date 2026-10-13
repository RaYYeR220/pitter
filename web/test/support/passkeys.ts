import { createHmac, randomBytes } from 'node:crypto'
import { MeraError } from '@category-labs/mera'
import { sha256, toBytes } from 'viem'
import type { CredentialHint, PasskeyResult, Passkeys } from '@/lib/account'

/** The salt Mera evaluates when none is given. */
export const MERA_DEFAULT_SALT = sha256(toBytes('mera.prf.salt.v1'), 'bytes')

export interface FakeAuthenticator extends Passkeys {
  /** Every ceremony run so far, in order. */
  ceremonies: Array<{ kind: 'create' | 'evaluate'; credentialId: string; salt: string; hinted: boolean }>
  /** The passkey a prompt without a hint resolves to. */
  select(credentialId: string): void
  /** Adds a passkey with a known secret, as if it had synced from another device. */
  add(credentialId: string, secret: Uint8Array): void
  /** Makes the next ceremony fail the way a real one does. */
  failNext(error: unknown): void
  credentials(): string[]
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

/**
 * An authenticator for tests. Like a real one, each passkey holds a secret and answers a salt with
 * HMAC-SHA-256 of it, so the output depends on the passkey and the salt and on nothing else.
 */
export function fakeAuthenticator(): FakeAuthenticator {
  const secrets = new Map<string, Uint8Array>()
  let selected: string | null = null
  let failure: unknown

  const evaluate = (credentialId: string, salt: Uint8Array): Uint8Array<ArrayBuffer> => {
    const secret = secrets.get(credentialId)
    if (!secret) throw new MeraError('PASSKEY_OPERATION_FAILED', 'no such passkey')
    return new Uint8Array(createHmac('sha256', secret).update(salt).digest())
  }

  const takeFailure = () => {
    if (failure === undefined) return
    const error = failure
    failure = undefined
    throw error
  }

  const authenticator: FakeAuthenticator = {
    ceremonies: [],

    async create({ prfSalt }): Promise<PasskeyResult> {
      takeFailure()
      const credentialId = randomBytes(16).toString('base64url')
      secrets.set(credentialId, randomBytes(32))
      selected = credentialId
      const salt = prfSalt ?? MERA_DEFAULT_SALT
      authenticator.ceremonies.push({ kind: 'create', credentialId, salt: hex(salt), hinted: false })
      return { credential: { credentialId, transports: ['internal'] }, prfOutput: evaluate(credentialId, salt) }
    },

    async evaluate({ credential, prfSalt } = {}): Promise<PasskeyResult> {
      takeFailure()
      const credentialId = credential?.credentialId ?? selected
      if (!credentialId) throw new MeraError('PASSKEY_OPERATION_FAILED', 'no passkey for this site')
      const salt = prfSalt ?? MERA_DEFAULT_SALT
      authenticator.ceremonies.push({
        kind: 'evaluate',
        credentialId,
        salt: hex(salt),
        hinted: credential !== undefined,
      })
      const result: CredentialHint = { credentialId }
      return { credential: result, prfOutput: evaluate(credentialId, salt) }
    },

    select(credentialId) {
      selected = credentialId
    },
    add(credentialId, secret) {
      secrets.set(credentialId, secret)
      selected ??= credentialId
    },
    failNext(error) {
      failure = error
    },
    credentials: () => [...secrets.keys()],
  }
  return authenticator
}

/** A clock a test moves by hand. */
export function manualClock(start = 1_800_000_000_000) {
  let now = start
  return {
    now: () => now,
    seconds: () => Math.floor(now / 1000),
    advance(milliseconds: number) {
      now += milliseconds
    },
    set(value: number) {
      now = value
    },
  }
}

/** Local storage for tests, with a record of everything ever written to it. */
export function memoryStorage() {
  const items = new Map<string, string>()
  const written: string[] = []
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem(key: string, value: string) {
      items.set(key, value)
      written.push(value)
    },
    removeItem(key: string) {
      items.delete(key)
    },
    clear() {
      items.clear()
    },
    written,
    size: () => items.size,
  }
}
