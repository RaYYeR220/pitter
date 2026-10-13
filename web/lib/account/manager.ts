import { createSecp256k1SigningSession } from '@category-labs/mera'
import { toViemAccount } from '@category-labs/mera/viem'
import { isAddressEqual, type Address, type LocalAccount } from 'viem'
import { deriveAccountKey } from './derive'
import {
  SignedOutError,
  WrongAccountError,
  currentPlatform,
  describeAccountError,
  type AccountProblem,
  type Platform,
} from './errors'
import { noHints, type HintStore } from './hints'
import type { CredentialHint, Passkeys } from './passkey'
import type { SessionScope } from './scope'
import { SigningSession, type CoverSigner, type PaymentTerms, type SessionTiming } from './session'

/** Actions that move money somewhere other than into cover. Each one takes its own passkey prompt, every time. */
export type SensitiveAction = 'cash_out' | 'pool_add' | 'pool_leave' | 'cover_over_limit'

export type AccountStatus = 'signed_out' | 'signing_up' | 'signing_in' | 'signed_in'

export interface AccountState {
  status: AccountStatus
  /** The account's address while signed in. */
  address: Address | null
  /** What the current sign-in allows without a prompt. */
  scope: SessionScope | null
  /** Why the last sign-in ended, until the next one starts. */
  ended: 'signed_out' | 'expired' | 'idle' | null
  /** What went wrong with the last passkey prompt, until the next one starts. */
  problem: AccountProblem | null
  /** The sensitive action a passkey prompt is currently open for. */
  confirming: SensitiveAction | null
  /** Whether a passkey prompt is open to replace a sign-in that is still live. */
  renewing: boolean
  /** Whether this device remembers an account to sign in to. A shortcut only. */
  returning: boolean
}

/** Limits a sign-in is opened with. */
export interface SessionPolicy {
  lengthMs: number
  idleMs: number
  maxSpendPerHour: bigint
}

/** Raised when a passkey prompt for a sensitive action did not produce the account's key. */
export class CeremonyError extends Error {
  readonly problem: AccountProblem

  constructor(problem: AccountProblem, cause: unknown) {
    super(problem.title, { cause })
    this.name = 'CeremonyError'
    this.problem = problem
  }
}

export interface AccountManagerOptions {
  passkeys: Passkeys
  /** Payee and signing domain of cover payments, read from the deployment. */
  terms: () => Promise<PaymentTerms>
  policy: SessionPolicy
  hints?: HintStore
  /** Unix milliseconds. */
  now?: () => number
  /** Name the passkey is saved under on the device. */
  label?: () => string
  platform?: () => Platform
}

const SIGNED_OUT: AccountState = {
  status: 'signed_out',
  address: null,
  scope: null,
  ended: null,
  problem: null,
  confirming: null,
  renewing: false,
  returning: false,
}

/**
 * The account layer: one passkey, through Mera, and nothing else.
 *
 * Signing up is one creation ceremony; signing in is one assertion with a discoverable credential, so it
 * works on a device that has never seen the account. Either way the PRF output becomes the account key, the
 * key goes into a scoped in-memory session, and nothing identifying is stored: the address is recomputed from
 * the passkey every time.
 */
export class AccountManager {
  private readonly passkeys: Passkeys
  private readonly terms: () => Promise<PaymentTerms>
  private readonly policy: SessionPolicy
  private readonly hints: HintStore
  private readonly now: () => number
  private readonly label: () => string
  private readonly platform: () => Platform
  private readonly listeners = new Set<() => void>()
  private session: SigningSession | null = null
  private state: AccountState = SIGNED_OUT
  private busy = false
  private awake = false

  constructor(options: AccountManagerOptions) {
    this.passkeys = options.passkeys
    this.terms = options.terms
    this.policy = options.policy
    this.hints = options.hints ?? noHints
    this.now = options.now ?? Date.now
    this.label = options.label ?? (() => 'Account')
    this.platform = options.platform ?? currentPlatform
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): AccountState => this.state

  /** Reads the device's hint, if any. Call once the page is in a browser. */
  restoreHint(): void {
    if (this.state.status === 'signed_out') this.update({ returning: this.hints.load() !== null })
  }

  /** Creates the account: one passkey ceremony, after which the person is signed in. */
  async signUp(policy: Partial<SessionPolicy> = {}): Promise<boolean> {
    return this.open('signing_up', policy, () => this.passkeys.create({ label: this.label() }))
  }

  /**
   * Signs in with an existing passkey: one ceremony.
   *
   * @param anyAccount Ignore the device's hint and let the platform offer every passkey of this site.
   */
  async signIn(policy: Partial<SessionPolicy> = {}, anyAccount = false): Promise<boolean> {
    const hint = anyAccount ? null : this.hints.load()
    return this.open('signing_in', policy, () =>
      this.passkeys.evaluate(hint ? { credential: hint.credential } : {}),
    )
  }

  signOut(): void {
    this.close('signed_out')
  }

  /** The passkey of the signed-in account, so other prompts can go straight to it. */
  credential(): CredentialHint | undefined {
    return this.session?.credential
  }

  /** The prompt-free signer for cover purchases, or null when nobody is signed in. */
  coverSigner(): CoverSigner | null {
    return this.session
  }

  /** Records that the person used the app. */
  touch(): void {
    this.session?.touch()
  }

  /** Suspends the idle timeout while cover is on. */
  keepAwake(awake: boolean): void {
    this.awake = awake
    this.session?.keepAwake(awake)
  }

  /** Ends the sign-in if it has expired or sat idle. Run it on a timer; the scope is enforced regardless. */
  evaluate(): void {
    const over = this.session?.over()
    if (over === 'expired' || over === 'idle') this.close(over)
  }

  timing(): SessionTiming | null {
    return this.session ? this.session.timing() : null
  }

  /**
   * Runs `work` with the account's key behind a fresh passkey prompt. The key exists for the length of the
   * call and is zeroed when it returns; the signed-in session is neither used nor extended.
   *
   * @throws SignedOutError when nobody is signed in.
   * @throws CeremonyError when the prompt fails or is answered with another account's passkey.
   */
  async confirm<T>(action: SensitiveAction, work: (account: LocalAccount) => Promise<T>): Promise<T> {
    const session = this.session
    if (!session || session.over() !== null) {
      this.evaluate()
      throw new SignedOutError()
    }
    if (this.state.confirming !== null) throw new Error('another confirmation is in progress')
    this.update({ confirming: action, problem: null })

    let fresh
    try {
      const { prfOutput } = await this.passkeys.evaluate({ credential: session.credential })
      const key = deriveAccountKey(prfOutput)
      prfOutput.fill(0)
      try {
        fresh = createSecp256k1SigningSession({ privateKey: key })
      } finally {
        key.fill(0)
      }
    } catch (error) {
      const problem = describeAccountError(error, this.platform())
      this.update({ confirming: null, problem })
      throw new CeremonyError(problem, error)
    }

    try {
      const account = toViemAccount(fresh)
      if (!isAddressEqual(account.address, session.address)) {
        const error = new WrongAccountError()
        const problem = describeAccountError(error, this.platform())
        this.update({ problem })
        throw new CeremonyError(problem, error)
      }
      session.touch()
      return await work(account)
    } finally {
      fresh.end()
      this.update({ confirming: null })
    }
  }

  /**
   * Runs a sign-in ceremony and opens a session on its result. A sign-in that is still live stays in use until
   * the new one has succeeded, so a cancelled prompt never signs anyone out.
   */
  private async open(
    status: 'signing_up' | 'signing_in',
    policy: Partial<SessionPolicy>,
    ceremony: () => Promise<{ credential: CredentialHint; prfOutput: Uint8Array }>,
  ): Promise<boolean> {
    if (this.busy) return false
    this.busy = true

    const previous = this.session && this.session.over() === null ? this.session : null
    if (previous) {
      this.update({ renewing: true, problem: null })
    } else {
      this.session?.end()
      this.session = null
      this.set({ ...SIGNED_OUT, status, returning: this.state.returning })
    }

    try {
      const { credential, prfOutput } = await ceremony()
      const key = deriveAccountKey(prfOutput)
      prfOutput.fill(0)

      const now = this.now()
      const limits = { ...this.policy, ...policy }
      const scope: SessionScope = {
        actions: ['cover.buy'],
        maxSpendPerHour: limits.maxSpendPerHour,
        expiresAt: now + limits.lengthMs,
        idleTimeoutMs: limits.idleMs,
      }
      let next: SigningSession
      try {
        next = new SigningSession({ privateKey: key, credential, scope, terms: this.terms, now: this.now })
      } finally {
        key.fill(0)
      }

      previous?.end()
      this.session = next
      next.keepAwake(this.awake)
      this.hints.save({ credential, address: next.address })
      this.set({ ...SIGNED_OUT, status: 'signed_in', address: next.address, scope, returning: true })
      return true
    } catch (error) {
      const problem = describeAccountError(error, this.platform())
      if (previous && previous.over() === null) {
        this.update({ renewing: false, problem })
      } else {
        previous?.end()
        this.session = null
        this.set({ ...SIGNED_OUT, problem, returning: this.hints.load() !== null })
      }
      return false
    } finally {
      this.busy = false
    }
  }

  private close(reason: 'signed_out' | 'expired' | 'idle'): void {
    if (!this.session) return
    this.session.end(reason === 'signed_out' ? 'ended' : reason)
    this.session = null
    this.set({ ...SIGNED_OUT, ended: reason, returning: this.hints.load() !== null })
  }

  private update(patch: Partial<AccountState>): void {
    this.set({ ...this.state, ...patch })
  }

  private set(state: AccountState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}
