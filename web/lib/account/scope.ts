/** What a signed-in session may sign without showing a prompt. There is one such action. */
export type ScopedAction = 'cover.buy'

export const HOUR_MS = 60 * 60 * 1000

/**
 * The limits of one sign-in. They are fixed when the passkey prompt is answered and cannot be widened
 * afterwards: a larger limit or a longer session takes a new prompt.
 */
export interface SessionScope {
  /** Everything the session signs on its own. Anything else needs a fresh passkey prompt. */
  readonly actions: readonly ScopedAction[]
  /** Most the session may spend in any sixty minutes, in base units of the dollar. */
  readonly maxSpendPerHour: bigint
  /** When the session ends whatever happens, unix milliseconds. */
  readonly expiresAt: number
  /** How long the session survives without activity, in milliseconds. */
  readonly idleTimeoutMs: number
}

export type ScopeRefusal = 'ended' | 'expired' | 'idle' | 'action' | 'spend_limit' | 'amount' | 'validity'

export type ScopeDecision =
  | { allowed: true }
  | {
      allowed: false
      reason: ScopeRefusal
      /** For `spend_limit`: what is left of the hourly limit, and when the oldest spend drops out of it. */
      remaining?: bigint
      availableAt?: number
    }

export interface SpendReservation {
  readonly id: number
  readonly amount: bigint
  readonly at: number
}

/** Raised when the session is asked for a signature its scope does not cover. Nothing was signed. */
export class ScopeError extends Error {
  readonly reason: ScopeRefusal
  readonly decision: ScopeDecision

  constructor(decision: Extract<ScopeDecision, { allowed: false }>) {
    super(`outside the session scope: ${decision.reason}`)
    this.name = 'ScopeError'
    this.reason = decision.reason
    this.decision = decision
  }
}

/**
 * Keeps a session inside its scope. Every prompt-free signature goes through `reserve`, which checks the
 * action, the expiry, the idle timeout and the hourly limit in one step and books the amount, so two requests
 * racing each other cannot both fit under a limit only one of them fits under.
 */
export class ScopeLedger {
  readonly scope: SessionScope
  private spends: SpendReservation[] = []
  private lastActivity: number
  private nextId = 1
  private awake = false
  private closed: 'ended' | 'expired' | 'idle' | null = null

  constructor(scope: SessionScope, now: number) {
    this.scope = scope
    this.lastActivity = now
  }

  /** Records that the person used the app. */
  touch(now: number): void {
    if (this.closed === null && now > this.lastActivity) this.lastActivity = now
  }

  /**
   * While cover is on the session is doing what it was opened for, so the idle timeout is suspended. The
   * expiry and the hourly limit still apply.
   */
  keepAwake(awake: boolean, now: number): void {
    if (this.awake && !awake) this.touch(now)
    this.awake = awake
  }

  /** Marks the session as over. Every later check is refused. */
  close(reason: 'ended' | 'expired' | 'idle'): void {
    this.closed ??= reason
  }

  get closedBy(): 'ended' | 'expired' | 'idle' | null {
    return this.closed
  }

  /** When the idle timeout would end the session; null while cover keeps it awake. */
  idleDeadline(): number | null {
    return this.awake ? null : this.lastActivity + this.scope.idleTimeoutMs
  }

  /** Why the session is over at `now`, or null while it is live. */
  expiredBy(now: number): 'ended' | 'expired' | 'idle' | null {
    if (this.closed !== null) return this.closed
    if (now >= this.scope.expiresAt) return 'expired'
    const idleAt = this.idleDeadline()
    if (idleAt !== null && now >= idleAt) return 'idle'
    return null
  }

  spentInLastHour(now: number): bigint {
    this.prune(now)
    return this.spends.reduce((sum, spend) => sum + spend.amount, 0n)
  }

  remaining(now: number): bigint {
    const left = this.scope.maxSpendPerHour - this.spentInLastHour(now)
    return left > 0n ? left : 0n
  }

  /** Whether the session would sign for `action` and `amount` at `now`. Books nothing. */
  check(action: string, amount: bigint, now: number): ScopeDecision {
    const over = this.expiredBy(now)
    if (over !== null) return { allowed: false, reason: over }
    if (!this.scope.actions.includes(action as ScopedAction)) return { allowed: false, reason: 'action' }
    if (amount <= 0n) return { allowed: false, reason: 'amount' }

    const remaining = this.remaining(now)
    if (amount > remaining) {
      const oldest = this.spends[0]
      return {
        allowed: false,
        reason: 'spend_limit',
        remaining,
        ...(oldest ? { availableAt: oldest.at + HOUR_MS } : {}),
      }
    }
    return { allowed: true }
  }

  /** Checks like `check` and, when allowed, books the amount against the hourly limit. */
  reserve(action: string, amount: bigint, now: number): SpendReservation {
    const decision = this.check(action, amount, now)
    if (!decision.allowed) throw new ScopeError(decision)
    const reservation: SpendReservation = { id: this.nextId++, amount, at: now }
    this.spends.push(reservation)
    return reservation
  }

  /** Gives back an amount whose payment is known never to have happened. */
  release(reservation: SpendReservation): void {
    this.spends = this.spends.filter((spend) => spend.id !== reservation.id)
  }

  private prune(now: number): void {
    this.spends = this.spends.filter((spend) => now - spend.at < HOUR_MS)
  }
}
