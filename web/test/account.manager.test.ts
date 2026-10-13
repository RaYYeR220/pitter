import { MeraError } from '@category-labs/mera'
import { entropyToMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { keccak256, recoverTypedDataAddress, toHex, type Address, type Hex } from 'viem'
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import {
  AccountManager,
  CeremonyError,
  HINT_KEY,
  HOUR_MS,
  ScopeError,
  SignedOutError,
  browserHintStore,
  deriveAccountKey,
  type PaymentTerms,
  type SessionPolicy,
} from '@/lib/account'
import { receiveAuthorization } from '@/lib/chain/erc3009'
import { MERA_DEFAULT_SALT, fakeAuthenticator, manualClock, memoryStorage } from './support/passkeys'

const TOKEN: Address = '0xDe6fb6D4C560C5901f733D53e591F2A0D6EB1438'
const BOOK: Address = '0x58d970780565E4C064369AD80eEC2D3581d6d75D'

const terms: PaymentTerms = {
  domain: { name: 'Test Dollar', version: '1', chainId: 10143, verifyingContract: TOKEN },
  payee: BOOK,
}

const policy: SessionPolicy = { lengthMs: 4 * HOUR_MS, idleMs: 20 * 60_000, maxSpendPerHour: 5_000_000n }

function setup() {
  const authenticator = fakeAuthenticator()
  const clock = manualClock()
  const storage = memoryStorage()
  const manager = new AccountManager({
    passkeys: authenticator,
    terms: async () => terms,
    policy,
    hints: browserHintStore(() => storage),
    now: clock.now,
    platform: () => ({ secureContext: true, webAuthn: true }),
  })
  return { authenticator, clock, storage, manager }
}

const payment = (clock: ReturnType<typeof manualClock>, value: bigint, nonce: Hex = keccak256(toHex(value))) => ({
  value,
  validAfter: 0n,
  validBefore: BigInt(clock.seconds() + 120),
  nonce,
})

describe('deriveAccountKey', () => {
  it('yields the first account of the 24-word phrase the PRF output encodes', () => {
    const prf = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
    const key = deriveAccountKey(prf)
    const expected = mnemonicToAccount(entropyToMnemonic(prf, wordlist))
    expect(privateKeyToAccount(toHex(key)).address).toBe(expected.address)
    expect(expected.address).toBe('0x50B240678777451BEfd67B7e8c3b4366482ba8F9')
  })

  it('is deterministic and refuses anything that is not 32 bytes', () => {
    const prf = Uint8Array.from({ length: 32 }, (_, i) => 255 - i)
    expect(toHex(deriveAccountKey(prf))).toBe(toHex(deriveAccountKey(Uint8Array.from(prf))))
    expect(() => deriveAccountKey(new Uint8Array(16))).toThrow(RangeError)
  })
})

describe('sign-up and sign-in', () => {
  it('signs up with one ceremony on the account salt', async () => {
    const { authenticator, manager } = setup()
    expect(await manager.signUp()).toBe(true)

    expect(authenticator.ceremonies).toHaveLength(1)
    expect(authenticator.ceremonies[0]).toMatchObject({ kind: 'create', salt: toHex(MERA_DEFAULT_SALT).slice(2) })
    const state = manager.getState()
    expect(state.status).toBe('signed_in')
    expect(state.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(state.scope).toMatchObject({ actions: ['cover.buy'], maxSpendPerHour: 5_000_000n })
  })

  it('reconstructs the same account from the passkey alone, with storage wiped', async () => {
    const { authenticator, storage, manager } = setup()
    await manager.signUp()
    const address = manager.getState().address
    manager.signOut()
    storage.clear()

    const fresh = new AccountManager({
      passkeys: authenticator,
      terms: async () => terms,
      policy,
      hints: browserHintStore(() => memoryStorage()),
    })
    expect(await fresh.signIn()).toBe(true)
    expect(fresh.getState().address).toBe(address)
    expect(authenticator.ceremonies.at(-1)).toMatchObject({ kind: 'evaluate', hinted: false })
  })

  it('points the next prompt at the remembered passkey, and can be told not to', async () => {
    const { authenticator, manager } = setup()
    await manager.signUp()
    manager.signOut()

    await manager.signIn()
    expect(authenticator.ceremonies.at(-1)).toMatchObject({ kind: 'evaluate', hinted: true })
    manager.signOut()

    await manager.signIn({}, true)
    expect(authenticator.ceremonies.at(-1)).toMatchObject({ kind: 'evaluate', hinted: false })
  })

  it('stores a credential hint and the address, and no key material', async () => {
    const { storage, manager } = setup()
    await manager.signUp()

    expect(storage.size()).toBe(1)
    const stored = JSON.parse(storage.getItem(HINT_KEY)!)
    expect(Object.keys(stored).sort()).toEqual(['address', 'credential'])
    expect(Object.keys(stored.credential).sort()).toEqual(['credentialId', 'transports'])
    expect(stored.address).toBe(manager.getState().address)
    for (const written of storage.written) expect(written).not.toMatch(/[0-9a-f]{64}/i)
  })

  it('reports a device without PRF and stays signed out', async () => {
    const { authenticator, manager } = setup()
    authenticator.failNext(new MeraError('PRF_UNAVAILABLE', 'Authenticator did not enable PRF'))
    expect(await manager.signUp()).toBe(false)
    expect(manager.getState()).toMatchObject({ status: 'signed_out', address: null })
    expect(manager.getState().problem).toMatchObject({ code: 'prf_unavailable', suggestPhone: true })
    expect(manager.coverSigner()).toBeNull()
  })

  it('clears the problem when the next attempt starts', async () => {
    const { authenticator, manager } = setup()
    authenticator.failNext(new MeraError('PASSKEY_OPERATION_FAILED', 'cancelled'))
    await manager.signUp()
    expect(manager.getState().problem?.code).toBe('cancelled')
    await manager.signUp()
    expect(manager.getState()).toMatchObject({ status: 'signed_in', problem: null })
  })

  it('notifies subscribers of every change', async () => {
    const { manager } = setup()
    const seen: string[] = []
    const unsubscribe = manager.subscribe(() => seen.push(manager.getState().status))
    await manager.signUp()
    manager.signOut()
    unsubscribe()
    await manager.signIn()
    expect(seen).toEqual(['signing_up', 'signed_in', 'signed_out'])
  })
})

describe('the prompt-free session', () => {
  it('signs a cover payment to the cover book without a ceremony', async () => {
    const { authenticator, clock, manager } = setup()
    await manager.signUp()
    const signer = manager.coverSigner()!
    const request = payment(clock, 15_000n)

    const { authorization } = await signer.signCoverPayment(request)
    expect(authenticator.ceremonies).toHaveLength(1)

    const signedBy = await recoverTypedDataAddress({
      ...receiveAuthorization(terms.domain, { from: signer.address, to: BOOK, ...request }),
      signature: { r: authorization.r, s: authorization.s, v: BigInt(authorization.v) },
    })
    expect(signedBy).toBe(signer.address)
    expect(authorization).toMatchObject({ validAfter: 0n, validBefore: request.validBefore })
  })

  it('offers no way to name another payee or another kind of signature', async () => {
    const { manager } = setup()
    await manager.signUp()
    const signer = manager.coverSigner()!
    const surface = new Set<string>()
    for (let proto: object | null = signer; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const name of Object.getOwnPropertyNames(proto)) surface.add(name)
    }
    for (const forbidden of ['signTypedData', 'signMessage', 'signTransaction', 'sign', 'privateKey']) {
      expect(surface.has(forbidden), forbidden).toBe(false)
    }
  })

  it('stops at the hourly limit and books nothing for the refused payment', async () => {
    const { clock, manager } = setup()
    await manager.signUp()
    const signer = manager.coverSigner()!

    await signer.signCoverPayment(payment(clock, 3_000_000n))
    expect(signer.check(2_000_001n)).toMatchObject({ allowed: false, reason: 'spend_limit', remaining: 2_000_000n })
    await expect(signer.signCoverPayment(payment(clock, 2_000_001n))).rejects.toBeInstanceOf(ScopeError)
    expect(manager.timing()).toMatchObject({ spentThisHour: 3_000_000n, spendRemaining: 2_000_000n })

    await signer.signCoverPayment(payment(clock, 2_000_000n))
    expect(manager.timing()?.spendRemaining).toBe(0n)
  })

  it('gives a released payment back to the limit', async () => {
    const { clock, manager } = setup()
    await manager.signUp()
    const signer = manager.coverSigner()!
    const { reservation } = await signer.signCoverPayment(payment(clock, 5_000_000n))
    signer.release(reservation)
    expect(signer.check(5_000_000n)).toEqual({ allowed: true })
  })

  it('refuses an authorization that would stay valid long after it is signed', async () => {
    const { clock, manager } = setup()
    await manager.signUp()
    const longLived = { ...payment(clock, 1_000n), validBefore: BigInt(clock.seconds() + 3600) }
    await expect(manager.coverSigner()!.signCoverPayment(longLived)).rejects.toMatchObject({ reason: 'validity' })
    expect(manager.timing()?.spentThisHour).toBe(0n)
  })

  it('refuses to sign once the session has expired, and reports why it ended', async () => {
    const { clock, manager } = setup()
    await manager.signUp()
    const signer = manager.coverSigner()!
    manager.keepAwake(true)
    clock.advance(4 * HOUR_MS)

    expect(signer.check(1_000n)).toEqual({ allowed: false, reason: 'expired' })
    await expect(signer.signCoverPayment(payment(clock, 1_000n))).rejects.toMatchObject({ reason: 'expired' })

    manager.evaluate()
    expect(manager.getState()).toMatchObject({ status: 'signed_out', ended: 'expired', address: null })
    expect(manager.coverSigner()).toBeNull()
    await expect(signer.signCoverPayment(payment(clock, 1_000n))).rejects.toBeInstanceOf(ScopeError)
  })

  it('signs out after sitting idle, unless cover keeps it awake', async () => {
    const { clock, manager } = setup()
    await manager.signUp()
    clock.advance(19 * 60_000)
    manager.touch()
    clock.advance(19 * 60_000)
    manager.evaluate()
    expect(manager.getState().status).toBe('signed_in')

    manager.keepAwake(true)
    clock.advance(HOUR_MS)
    manager.evaluate()
    expect(manager.getState().status).toBe('signed_in')
    expect(manager.timing()?.idleRemainingMs).toBeNull()

    manager.keepAwake(false)
    clock.advance(20 * 60_000)
    manager.evaluate()
    expect(manager.getState()).toMatchObject({ status: 'signed_out', ended: 'idle' })
  })

  it('zeroes the key on sign-out', async () => {
    const { clock, manager } = setup()
    await manager.signUp()
    const signer = manager.coverSigner()!
    manager.signOut()
    expect(manager.getState()).toMatchObject({ status: 'signed_out', ended: 'signed_out' })
    await expect(signer.signCoverPayment(payment(clock, 1_000n))).rejects.toMatchObject({ reason: 'ended' })
  })

  it('reports the time and the spend that are left', async () => {
    const { clock, manager } = setup()
    await manager.signUp()
    clock.advance(60_000)
    expect(manager.timing()).toMatchObject({
      remainingMs: 4 * HOUR_MS - 60_000,
      idleRemainingMs: 19 * 60_000,
      maxSpendPerHour: 5_000_000n,
      spentThisHour: 0n,
    })
  })

  it('opens with the limits asked for at the prompt', async () => {
    const { clock, manager } = setup()
    await manager.signUp({ maxSpendPerHour: 2_000_000n, lengthMs: HOUR_MS })
    expect(manager.getState().scope).toMatchObject({
      maxSpendPerHour: 2_000_000n,
      expiresAt: clock.now() + HOUR_MS,
    })
  })

  it('keeps the live session when a renewal prompt is closed, and replaces it when one succeeds', async () => {
    const { authenticator, clock, manager } = setup()
    await manager.signUp()
    const first = manager.coverSigner()!
    const address = first.address
    manager.keepAwake(true)
    clock.advance(HOUR_MS)

    authenticator.failNext(new MeraError('PASSKEY_OPERATION_FAILED', 'cancelled'))
    expect(await manager.signIn()).toBe(false)
    expect(manager.getState()).toMatchObject({ status: 'signed_in', address, renewing: false })
    expect(manager.getState().problem?.code).toBe('cancelled')
    expect(manager.coverSigner()).toBe(first)

    expect(await manager.signIn()).toBe(true)
    expect(manager.getState()).toMatchObject({ status: 'signed_in', address, problem: null })
    expect(manager.getState().scope?.expiresAt).toBe(clock.now() + 4 * HOUR_MS)
    expect(manager.coverSigner()).not.toBe(first)
    await expect(first.signCoverPayment(payment(clock, 1_000n))).rejects.toBeInstanceOf(ScopeError)
  })
})

describe('sensitive actions', () => {
  it('run a fresh ceremony every time and hand out the account’s key only for that call', async () => {
    const { authenticator, manager } = setup()
    await manager.signUp()
    const address = manager.getState().address!

    for (const action of ['cash_out', 'pool_add', 'pool_leave'] as const) {
      const before = authenticator.ceremonies.length
      let during: string | null = null
      const signed = await manager.confirm(action, async (account) => {
        during = manager.getState().confirming
        return { address: account.address, signature: await account.signMessage({ message: action }) }
      })
      expect(authenticator.ceremonies.length).toBe(before + 1)
      expect(authenticator.ceremonies.at(-1)).toMatchObject({ kind: 'evaluate', hinted: true })
      expect(during).toBe(action)
      expect(signed.address).toBe(address)
      expect(manager.getState().confirming).toBeNull()
    }
  })

  it('end the one-off key when the work is done', async () => {
    const { manager } = setup()
    await manager.signUp()
    let leaked: { signMessage(args: { message: string }): Promise<Hex> } | undefined
    await manager.confirm('cash_out', async (account) => {
      leaked = account
    })
    await expect(leaked!.signMessage({ message: 'later' })).rejects.toMatchObject({ code: 'SESSION_ENDED' })
  })

  it('do not count against, or extend, the prompt-free session', async () => {
    const { clock, manager } = setup()
    await manager.signUp()
    const expiresAt = manager.getState().scope!.expiresAt
    clock.advance(10 * 60_000)
    await manager.confirm('cash_out', async () => undefined)
    expect(manager.getState().scope!.expiresAt).toBe(expiresAt)
    expect(manager.timing()?.spentThisHour).toBe(0n)
  })

  it('refuse a passkey that belongs to another account', async () => {
    const { authenticator, manager } = setup()
    await manager.signUp()
    const mine = authenticator.credentials()[0]!
    const other = fakeAuthenticator()
    const impostor: typeof authenticator = {
      ...authenticator,
      evaluate: async () => other.create({ label: 'other' }),
    }
    const manager2 = new AccountManager({ passkeys: impostor, terms: async () => terms, policy })
    authenticator.select(mine)
    await manager2.signIn()
    const signedInAs = manager2.getState().address

    let ran = false
    await expect(
      manager2.confirm('cash_out', async () => {
        ran = true
      }),
    ).rejects.toBeInstanceOf(CeremonyError)
    expect(ran).toBe(false)
    expect(manager2.getState().problem?.code).toBe('wrong_account')
    expect(manager2.getState().address).toBe(signedInAs)
  })

  it('surface a closed prompt as a problem and leave the session alone', async () => {
    const { authenticator, manager } = setup()
    await manager.signUp()
    authenticator.failNext(new MeraError('PASSKEY_OPERATION_FAILED', 'cancelled'))
    await expect(manager.confirm('cash_out', async () => 1)).rejects.toMatchObject({
      problem: { code: 'cancelled', retry: true },
    })
    expect(manager.getState()).toMatchObject({ status: 'signed_in', confirming: null })
  })

  it('pass through whatever the work itself throws', async () => {
    const { manager } = setup()
    await manager.signUp()
    const failure = new Error('relay refused')
    await expect(
      manager.confirm('pool_add', async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(manager.getState()).toMatchObject({ confirming: null, problem: null })
  })

  it('need a signed-in account', async () => {
    const { clock, manager } = setup()
    await expect(manager.confirm('cash_out', async () => 1)).rejects.toBeInstanceOf(SignedOutError)

    await manager.signUp()
    clock.advance(21 * 60_000)
    await expect(manager.confirm('cash_out', async () => 1)).rejects.toBeInstanceOf(SignedOutError)
    expect(manager.getState()).toMatchObject({ status: 'signed_out', ended: 'idle' })
  })
})
