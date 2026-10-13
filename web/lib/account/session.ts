import { createSecp256k1SigningSession, type Secp256k1SigningSession } from '@category-labs/mera'
import { toViemAccount } from '@category-labs/mera/viem'
import type { Address, Hex, LocalAccount } from 'viem'
import {
  receiveAuthorization,
  toAuthorization,
  type Authorization,
  type AuthorizationMessage,
  type TokenDomain,
} from '../chain/erc3009'
import type { CredentialHint } from './passkey'
import { ScopeError, ScopeLedger, type ScopeDecision, type SessionScope, type SpendReservation } from './scope'

/** Where a cover payment goes and under which domain it is signed. Fixed by the deployment, not by the caller. */
export interface PaymentTerms {
  domain: TokenDomain
  /** The cover book: the only payee the session will ever sign for. */
  payee: Address
}

/** What the buyer of cover decides about a payment. The payer and the payee are not among it. */
export interface CoverPaymentRequest {
  value: bigint
  validAfter: bigint
  validBefore: bigint
  /** The digest of the quote being bought, which ties the payment to its terms. */
  nonce: Hex
}

export interface SignedCoverPayment {
  authorization: Authorization
  /** The booking against the hourly limit. Hand it back with `release` if the payment never happened. */
  reservation: SpendReservation
}

/**
 * The whole signing surface the cover engine is given. It can ask whether an amount fits the scope and it can
 * have a cover payment signed; there is no way through it to sign anything else.
 */
export interface CoverSigner {
  readonly address: Address
  /** Whether a cover payment of `amount` would be signed right now. Consult it before every purchase. */
  check(amount: bigint): ScopeDecision
  /** Signs a payment to the cover book if, and only if, the scope allows it. Throws `ScopeError` otherwise. */
  signCoverPayment(payment: CoverPaymentRequest): Promise<SignedCoverPayment>
  release(reservation: SpendReservation): void
}

/** How the session stands at one moment. */
export interface SessionTiming {
  expiresAt: number
  remainingMs: number
  /** Time left before the idle timeout; null while cover keeps the session awake. */
  idleRemainingMs: number | null
  maxSpendPerHour: bigint
  spentThisHour: bigint
  spendRemaining: bigint
}

/** A payment authorization may not outlive the quote it pays for by much; quotes last two minutes. */
const MAX_VALIDITY_SECONDS = 15 * 60

export interface SigningSessionOptions {
  /** 32-byte account key. The session keeps its own copy; the caller zeroes this one. */
  privateKey: Uint8Array
  credential: CredentialHint
  scope: SessionScope
  terms: () => Promise<PaymentTerms>
  /** Unix milliseconds. */
  now: () => number
}

/**
 * A signed-in account: a Mera signing session holding the key in memory, wrapped so that the only signature it
 * gives without a prompt is a cover payment inside its scope.
 *
 * The key never leaves this object and the viem account built on it is not exposed. Ending the session zeroes
 * the key; nothing about it is written to storage.
 */
export class SigningSession implements CoverSigner {
  readonly address: Address
  readonly credential: CredentialHint
  readonly scope: SessionScope
  private readonly mera: Secp256k1SigningSession
  private readonly account: LocalAccount
  private readonly ledger: ScopeLedger
  private readonly terms: () => Promise<PaymentTerms>
  private readonly now: () => number

  constructor(options: SigningSessionOptions) {
    this.mera = createSecp256k1SigningSession({ privateKey: options.privateKey })
    this.account = toViemAccount(this.mera)
    this.address = this.account.address
    this.credential = options.credential
    this.scope = options.scope
    this.terms = options.terms
    this.now = options.now
    this.ledger = new ScopeLedger(options.scope, options.now())
  }

  check(amount: bigint): ScopeDecision {
    return this.ledger.check('cover.buy', amount, this.now())
  }

  async signCoverPayment(payment: CoverPaymentRequest): Promise<SignedCoverPayment> {
    const terms = await this.terms()
    const now = this.now()
    if (payment.validBefore > BigInt(Math.floor(now / 1000) + MAX_VALIDITY_SECONDS)) {
      throw new ScopeError({ allowed: false, reason: 'validity' })
    }

    const reservation = this.ledger.reserve('cover.buy', payment.value, now)
    try {
      const message: AuthorizationMessage = { from: this.address, to: terms.payee, ...payment }
      const signature = await this.account.signTypedData(receiveAuthorization(terms.domain, message))
      return { authorization: toAuthorization(message, signature), reservation }
    } catch (error) {
      this.ledger.release(reservation)
      throw error
    }
  }

  release(reservation: SpendReservation): void {
    this.ledger.release(reservation)
  }

  /** Records that the person used the app, which restarts the idle timeout. */
  touch(): void {
    this.ledger.touch(this.now())
  }

  /** Suspends the idle timeout while cover is on. */
  keepAwake(awake: boolean): void {
    this.ledger.keepAwake(awake, this.now())
  }

  /** Why the session is over, or null while it is live. */
  over(): 'ended' | 'expired' | 'idle' | null {
    return this.ledger.expiredBy(this.now())
  }

  timing(): SessionTiming {
    const now = this.now()
    const idleAt = this.ledger.idleDeadline()
    return {
      expiresAt: this.scope.expiresAt,
      remainingMs: Math.max(0, this.scope.expiresAt - now),
      idleRemainingMs: idleAt === null ? null : Math.max(0, idleAt - now),
      maxSpendPerHour: this.scope.maxSpendPerHour,
      spentThisHour: this.ledger.spentInLastHour(now),
      spendRemaining: this.ledger.remaining(now),
    }
  }

  /** Zeroes the key. Every later signature is refused. */
  end(reason: 'ended' | 'expired' | 'idle' = 'ended'): void {
    this.ledger.close(reason)
    this.mera.end()
  }
}
