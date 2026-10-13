import { isAddressEqual, type Address, type Hex } from 'viem'
import { ScopeError, type SpendReservation } from '../account/scope'
import type { CoverPaymentRequest, CoverSigner } from '../account/session'
import type { Authorization } from '../chain/erc3009'
import type { BuyReceipt, QuoteRequest, SignedQuote } from '../service/client'
import type { Area } from './area'
import { QuoteMismatch, checkQuote, earliestStart, nextWindow, priceView, type PriceView } from './quote'
import { refusal, refusalFrom, type Refusal } from './refusals'

/** One purchase of cover made through the engine. */
export interface CoverBlock {
  key: bigint
  start: number
  end: number
  premium: bigint
  ratePerSecond: bigint
  /** `block`: ten minutes bought by the switch. `shift`: a whole shift locked at one price. */
  kind: 'block' | 'shift'
  /** Null when the purchase was confirmed from the chain rather than from the relay's answer. */
  policyId: bigint | null
  transactionHash: Hex | null
}

/** Why the engine turned cover off by itself. */
export type StopReason =
  | { kind: 'refused'; refusal: Refusal }
  | { kind: 'session_expired' }
  | { kind: 'spend_limit'; limit: bigint }
  | { kind: 'insufficient_balance'; needed: bigint; balance: bigint }
  /** Gave up after retrying for a while. */
  | { kind: 'unavailable'; refusal: Refusal }

export interface CoverEngineState {
  /** Position of the switch. */
  status: 'off' | 'on'
  /** `confirming`: a purchase was sent and the chain is being asked whether it landed. */
  activity: 'idle' | 'buying' | 'confirming' | 'retrying'
  area: Area | null
  ratePerSecond: bigint
  /** Purchases made since the switch was last turned on, oldest first. */
  blocks: CoverBlock[]
  /** End of the paid-up cover in this area, as far as the engine knows. */
  coveredUntil: number | null
  /** Stretches without cover while the switch was on. */
  gaps: Array<{ from: number; to: number }>
  /** The latest price seen for this area, bought or only looked at. */
  price: PriceView | null
  /** Why no price can be had right now. */
  priceRefusal: Refusal | null
  /** Why the engine turned itself off; cleared when cover is turned on again. */
  stopped: StopReason | null
  /** The refusal being retried, and when. */
  retrying: Refusal | null
  retryAt: number | null
}

export interface CoverEnginePorts {
  /** Unix seconds. */
  now(): number
  /** The signed-in account's prompt-free signer; null when nobody is signed in. */
  signer(): CoverSigner | null
  quote(request: QuoteRequest): Promise<SignedQuote>
  relayBuy(quote: SignedQuote, authorization: Authorization): Promise<BuyReceipt>
  balance(holder: Address): Promise<bigint>
  /** Whether a quote with this digest has been bought. */
  quoteUsed(digest: Hex): Promise<boolean>
  /** Seconds the book demands between a purchase and the start of its window. */
  minLead(): Promise<number>
  /** End of the cover the holder already has in an area, read from the chain. */
  coveredUntil(holder: Address, key: bigint): Promise<number | null>
  deployment: { chainId: number; coverBook: Address }
  /** Told while cover is on, so the sign-in does not idle out under it. */
  keepAwake?(awake: boolean): void
  onBought?(block: CoverBlock): void
}

export interface CoverEngineOptions {
  /** Length of one pay-as-you-go block, seconds. */
  blockSeconds: number
  /** How long before the paid-up cover ends the next block is bought. */
  renewLeadSeconds: number
  /** How long transient failures are retried before the engine gives up. */
  giveUpAfterSeconds?: number
}

/** A price for a whole shift, ready to be locked. */
export interface ShiftOffer {
  area: Area
  signed: SignedQuote
  digest: Hex
  price: PriceView
}

/** A refusal, thrown. */
export class RefusalError extends Error {
  readonly refusal: Refusal

  constructor(refused: Refusal) {
    super(refused.message)
    this.name = 'RefusalError'
    this.refusal = refused
  }
}

/** Raised when locking a shift would pass the session's hourly limit: it needs a passkey prompt. */
export class NeedsConfirmation extends Error {
  readonly amount: bigint

  constructor(amount: bigint) {
    super('this purchase is above the session limit')
    this.name = 'NeedsConfirmation'
    this.amount = amount
  }
}

type Outcome =
  | { type: 'cancelled' }
  | { type: 'bought'; block: CoverBlock }
  | { type: 'uncertain' }
  | { type: 'refused'; refusal: Refusal }
  | { type: 'stopped'; reason: StopReason }

interface Unresolved {
  signed: SignedQuote
  digest: Hex
  kind: CoverBlock['kind']
  signer: CoverSigner
  reservation: SpendReservation | null
  gap: { from: number; to: number } | null
}

/**
 * After a quote has expired the book rejects it, so a purchase that has not landed by then never will. The
 * margin covers the difference between this device's clock and the chain's.
 */
const EXPIRY_MARGIN_SECONDS = 30

const INITIAL: CoverEngineState = {
  status: 'off',
  activity: 'idle',
  area: null,
  ratePerSecond: 0n,
  blocks: [],
  coveredUntil: null,
  gaps: [],
  price: null,
  priceRefusal: null,
  stopped: null,
  retrying: null,
  retryAt: null,
}

/**
 * Keeps cover on. While the switch is on it buys the next block shortly before the current one ends, at the
 * price quoted at that moment, and stops the moment it is refused, the sign-in runs out, the hourly limit is
 * reached or the balance is too low. Turning the switch off only stops further buying.
 *
 * It is driven by `tick`, which looks at the clock and decides; it holds no timers of its own, so a tab that
 * was asleep for half an hour simply resumes from the present. Two rules hold whatever the timing:
 *
 * - a window is never bought twice: blocks start where the paid-up cover ends, and a purchase whose outcome
 *   is unknown blocks every other purchase until the chain has confirmed it or its quote has expired;
 * - nothing is signed outside the session's scope: the signer is asked before every purchase and signs only
 *   cover payments.
 */
export class CoverEngine {
  private readonly ports: CoverEnginePorts
  private readonly options: Required<CoverEngineOptions>
  private readonly listeners = new Set<() => void>()
  private state: CoverEngineState = INITIAL
  private busy = false
  private ready = false
  private minLead = 0
  private holder: Address | null = null
  private unresolved: Unresolved | null = null
  private retryAt: number | null = null
  private failures = 0
  private firstFailureAt: number | null = null
  private previews = 0

  constructor(ports: CoverEnginePorts, options: CoverEngineOptions) {
    this.ports = ports
    this.options = { giveUpAfterSeconds: 300, ...options }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): CoverEngineState => this.state

  /** The switch, read fresh: it can move while a purchase is waiting on the network. */
  private isOn(): boolean {
    return this.state.status === 'on'
  }

  /** Turns the switch on and buys the first block. */
  async turnOn(area: Area, ratePerSecond: bigint): Promise<void> {
    if (this.state.status === 'on') return
    const signer = this.ports.signer()
    if (!signer) {
      this.update({ stopped: { kind: 'session_expired' } })
      return
    }
    this.holder = signer.address
    this.ready = false
    this.clearRetry()
    this.set({
      ...INITIAL,
      status: 'on',
      activity: 'buying',
      area,
      ratePerSecond,
      price: this.sameArea(area) ? this.state.price : null,
    })
    this.ports.keepAwake?.(true)
    await this.tick()
  }

  /** Turns the switch off. Cover already bought keeps running; nothing is refunded. */
  turnOff(): void {
    if (this.state.status === 'off') return
    this.clearRetry()
    this.update({ status: 'off', activity: this.unresolved ? 'confirming' : 'idle', stopped: null })
    this.ports.keepAwake?.(false)
  }

  /** Forgets everything about the account that was signed in. */
  reset(): void {
    this.previews++
    this.unresolved = null
    this.holder = null
    this.ready = false
    this.clearRetry()
    if (this.state.status === 'on') this.ports.keepAwake?.(false)
    this.set(INITIAL)
  }

  /**
   * One step. Call it every second and whenever the page becomes visible again; it does nothing unless
   * something is due, and it never throws.
   */
  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await this.step()
    } catch (error) {
      if (this.state.status === 'on') this.refused(refusalFrom(error))
    } finally {
      this.busy = false
    }
  }

  /**
   * Looks up the price of the next block without buying it, so the person sees what cover costs, or why it
   * cannot be had, before turning it on.
   */
  async preview(area: Area, ratePerSecond: bigint): Promise<void> {
    const signer = this.ports.signer()
    if (!signer || this.state.status === 'on') return
    const turn = ++this.previews
    try {
      const minLead = await this.ports.minLead()
      const window = nextWindow(this.ports.now(), minLead, this.options.blockSeconds, null)
      const request = this.request(area, ratePerSecond, window, signer.address)
      const signed = await this.ports.quote(request)
      checkQuote(signed, { ...request, key: area.key }, this.ports.deployment, this.ports.now())
      if (turn !== this.previews || this.isOn()) return
      this.update({ area, ratePerSecond, price: priceView(signed), priceRefusal: null })
    } catch (error) {
      if (turn !== this.previews || this.isOn()) return
      this.update({ area, ratePerSecond, price: null, priceRefusal: this.describe(error) })
    }
  }

  /**
   * Prices one window for a whole shift. Nothing is bought until the offer is handed to `lockShift`.
   *
   * @throws RefusalError when the shift cannot be priced or is not on offer.
   */
  async quoteShift(area: Area, ratePerSecond: bigint, seconds: number): Promise<ShiftOffer> {
    const signer = this.ports.signer()
    if (!signer) throw new RefusalError(refusal('invalid', 'signed_out'))
    try {
      const [minLead, existing] = await Promise.all([
        this.ports.minLead(),
        this.ports.coveredUntil(signer.address, area.key),
      ])
      const known = this.sameArea(area) ? this.state.coveredUntil : null
      const covered = Math.max(existing ?? 0, known ?? 0)
      const start = Math.max(covered, earliestStart(this.ports.now(), minLead))
      const request = this.request(area, ratePerSecond, { start, end: start + seconds }, signer.address)
      const signed = await this.ports.quote(request)
      const digest = checkQuote(signed, { ...request, key: area.key }, this.ports.deployment, this.ports.now())
      return { area, signed, digest, price: priceView(signed) }
    } catch (error) {
      throw new RefusalError(this.describe(error))
    }
  }

  /**
   * Buys the shift an offer describes.
   *
   * @param signWith Signs the payment behind a fresh passkey prompt. Without it the session signs, if its
   * scope allows the amount.
   * @throws NeedsConfirmation when the amount is above the session's limit and no `signWith` was given.
   * @throws RefusalError when the purchase is refused, or was sent and is not confirmed yet.
   */
  async lockShift(
    offer: ShiftOffer,
    signWith?: (payment: CoverPaymentRequest) => Promise<Authorization>,
  ): Promise<CoverBlock> {
    const signer = this.ports.signer()
    if (!signer) throw new RefusalError(refusal('invalid', 'signed_out'))
    if (this.busy || this.unresolved) throw new RefusalError(refusal('busy', 'purchase_in_progress'))
    if (BigInt(this.ports.now()) >= offer.signed.quote.expiry) throw new RefusalError(refusal('quote_expired'))
    if (this.overlaps(offer.area.key, Number(offer.signed.quote.start), Number(offer.signed.quote.end))) {
      throw new RefusalError(refusal('already_bought'))
    }

    this.busy = true
    try {
      const outcome = await this.pay(signer, offer.signed, offer.digest, 'shift', null, signWith)
      switch (outcome.type) {
        case 'cancelled':
          throw new RefusalError(refusal('invalid', 'cancelled'))
        case 'bought':
          this.record(outcome.block, offer.area)
          return outcome.block
        case 'uncertain':
          throw new RefusalError(refusal('pending', 'relay'))
        case 'refused':
          throw new RefusalError(outcome.refusal)
        case 'stopped':
          if (outcome.reason.kind === 'spend_limit') throw new NeedsConfirmation(offer.signed.quote.premium)
          if (outcome.reason.kind === 'insufficient_balance') throw new RefusalError(refusal('insufficient_balance'))
          throw new RefusalError(
            outcome.reason.kind === 'session_expired' ? refusal('invalid', 'signed_out') : outcome.reason.refusal,
          )
      }
    } finally {
      this.busy = false
    }
  }

  private async step(): Promise<void> {
    if (this.unresolved) {
      await this.resolve()
      if (this.unresolved) return
    }
    if (this.state.status !== 'on') return

    const { area, ratePerSecond } = this.state
    const signer = this.ports.signer()
    if (!signer || !this.holder || !isAddressEqual(signer.address, this.holder) || !area) {
      this.stop({ kind: 'session_expired' })
      return
    }

    const now = this.ports.now()
    if (this.retryAt !== null && now < this.retryAt) return

    if (!this.ready) {
      try {
        const [minLead, existing] = await Promise.all([
          this.ports.minLead(),
          this.ports.coveredUntil(signer.address, area.key),
        ])
        this.minLead = minLead
        this.ready = true
        if (existing !== null) this.update({ coveredUntil: existing })
      } catch {
        this.refused(refusal('network', 'chain'))
        return
      }
      if (!this.isOn()) return
    }

    const until = this.state.coveredUntil
    if (until !== null && now < until - this.options.renewLeadSeconds - this.minLead) {
      if (this.state.activity !== 'idle') this.update({ activity: 'idle', retrying: null, retryAt: null })
      return
    }

    const allowed = signer.check(1n)
    if (!allowed.allowed) {
      this.stop(
        allowed.reason === 'spend_limit'
          ? { kind: 'spend_limit', limit: signer.scope.maxSpendPerHour }
          : { kind: 'session_expired' },
      )
      return
    }

    const window = nextWindow(now, this.minLead, this.options.blockSeconds, until)
    if (this.overlaps(area.key, window.start, window.end)) return

    if (this.state.activity !== 'buying') this.update({ activity: 'buying' })
    const request = this.request(area, ratePerSecond, window, signer.address)
    let signed: SignedQuote
    let digest: Hex
    try {
      signed = await this.ports.quote(request)
      digest = checkQuote(signed, { ...request, key: area.key }, this.ports.deployment, this.ports.now())
    } catch (error) {
      this.refused(this.describe(error))
      return
    }
    if (!this.isOn()) return
    this.update({ price: priceView(signed), priceRefusal: null })

    const outcome = await this.pay(signer, signed, digest, 'block', window.gap)
    switch (outcome.type) {
      case 'bought':
        this.record(outcome.block, area, window.gap)
        return
      case 'uncertain':
        this.update({ activity: 'confirming' })
        return
      case 'refused':
        this.refused(outcome.refusal)
        return
      case 'stopped':
        this.stop(outcome.reason)
        return
      case 'cancelled':
        this.update({ activity: 'idle' })
    }
  }

  /**
   * Pays for a quote: balance, scope, signature, relay. The scope is consulted here, immediately before the
   * signature, and nowhere is a payment signed without it or without a fresh prompt.
   */
  private async pay(
    signer: CoverSigner,
    signed: SignedQuote,
    digest: Hex,
    kind: CoverBlock['kind'],
    gap: Unresolved['gap'],
    signWith?: (payment: CoverPaymentRequest) => Promise<Authorization>,
  ): Promise<Outcome> {
    const { quote } = signed
    const payment: CoverPaymentRequest = {
      value: quote.premium,
      validAfter: 0n,
      validBefore: quote.expiry,
      nonce: digest,
    }

    let balance: bigint
    try {
      balance = await this.ports.balance(signer.address)
    } catch {
      return { type: 'refused', refusal: refusal('network', 'chain') }
    }
    if (balance < quote.premium) {
      return { type: 'stopped', reason: { kind: 'insufficient_balance', needed: quote.premium, balance } }
    }

    if (kind === 'block' && !this.isOn()) return { type: 'cancelled' }

    let authorization: Authorization
    let reservation: SpendReservation | null = null
    if (signWith) {
      authorization = await signWith(payment)
    } else {
      const outsideScope = (reason: string): Outcome => ({
        type: 'stopped',
        reason:
          reason === 'spend_limit'
            ? { kind: 'spend_limit', limit: signer.scope.maxSpendPerHour }
            : { kind: 'session_expired' },
      })
      const decision = signer.check(quote.premium)
      if (!decision.allowed) return outsideScope(decision.reason)
      try {
        const result = await signer.signCoverPayment(payment)
        authorization = result.authorization
        reservation = result.reservation
      } catch (error) {
        if (error instanceof ScopeError) return outsideScope(error.reason)
        return { type: 'refused', refusal: refusal('network', 'chain') }
      }
    }

    try {
      const receipt = await this.ports.relayBuy(signed, authorization)
      return { type: 'bought', block: blockOf(signed, kind, receipt) }
    } catch (error) {
      const refused = refusalFrom(error)
      if (refused.kind === 'already_bought') return { type: 'bought', block: blockOf(signed, kind, null) }
      if (refused.outcomeUnknown) {
        this.unresolved = { signed, digest, kind, signer, reservation, gap }
        return { type: 'uncertain' }
      }
      if (reservation) signer.release(reservation)
      return { type: 'refused', refusal: refused }
    }
  }

  /** Asks the chain what became of a purchase whose answer never arrived. */
  private async resolve(): Promise<void> {
    const pending = this.unresolved
    if (!pending) return
    const now = this.ports.now()
    if (this.retryAt !== null && now < this.retryAt) return

    let used: boolean
    try {
      used = await this.ports.quoteUsed(pending.digest)
    } catch {
      this.retryAt = now + 5
      return
    }

    if (used) {
      this.unresolved = null
      this.retryAt = null
      this.record(blockOf(pending.signed, pending.kind, null), this.state.area, pending.gap)
      return
    }
    if (now > Number(pending.signed.quote.expiry) + EXPIRY_MARGIN_SECONDS) {
      if (pending.reservation) pending.signer.release(pending.reservation)
      this.unresolved = null
      this.retryAt = null
      this.update({ activity: this.state.status === 'on' ? 'buying' : 'idle' })
      return
    }
    this.retryAt = now + 3
  }

  private record(block: CoverBlock, area: Area | null, gap: Unresolved['gap'] = null): void {
    this.clearRetry()
    const moves = area !== null && !this.sameArea(area) && !this.isOn()
    const tracks = moves || (area !== null && this.sameArea(area)) || area === null
    const until = moves ? null : this.state.coveredUntil
    this.update({
      ...(moves ? { area, ratePerSecond: block.ratePerSecond, gaps: [] } : {}),
      activity: 'idle',
      blocks: [...this.state.blocks, block],
      ...(tracks ? { coveredUntil: until !== null && until > block.end ? until : block.end } : {}),
      ...(gap && this.state.blocks.length > 0 && !moves ? { gaps: [...this.state.gaps, gap] } : {}),
      retrying: null,
      retryAt: null,
    })
    this.ports.onBought?.(block)
  }

  private refused(refused: Refusal): void {
    if (refused.retry === 'never') {
      this.stop({ kind: 'refused', refusal: refused })
      return
    }
    const now = this.ports.now()
    this.firstFailureAt ??= now
    this.failures++
    if (now - this.firstFailureAt >= this.options.giveUpAfterSeconds) {
      this.stop({ kind: 'unavailable', refusal: refused })
      return
    }
    const backoff = 2 ** Math.min(this.failures - 1, 3)
    const delay = refused.retry === 'now' ? backoff : Math.min(30, refused.retryAfterSeconds ?? 5 * backoff)
    this.retryAt = now + delay
    this.update({ activity: 'retrying', retrying: refused, retryAt: this.retryAt })
  }

  private stop(reason: StopReason): void {
    this.clearRetry()
    this.update({ status: 'off', activity: this.unresolved ? 'confirming' : 'idle', stopped: reason, retrying: null, retryAt: null })
    this.ports.keepAwake?.(false)
  }

  private describe(error: unknown): Refusal {
    if (error instanceof QuoteMismatch) return refusal('invalid', `quote:${error.field}`)
    return refusalFrom(error)
  }

  private request(
    area: Area,
    ratePerSecond: bigint,
    window: { start: number; end: number },
    holder: Address,
  ): QuoteRequest {
    return { lat: area.lat, lon: area.lon, start: window.start, end: window.end, rate: ratePerSecond, holder }
  }

  /** Whether cover bought through this engine already includes any second of a window. */
  private overlaps(key: bigint, start: number, end: number): boolean {
    return this.state.blocks.some((block) => block.key === key && block.start < end && start < block.end)
  }

  private sameArea(area: Area): boolean {
    return this.state.area !== null && this.state.area.key === area.key
  }

  private clearRetry(): void {
    this.retryAt = null
    this.failures = 0
    this.firstFailureAt = null
  }

  private update(patch: Partial<CoverEngineState>): void {
    this.set({ ...this.state, ...patch })
  }

  private set(state: CoverEngineState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}

function blockOf(signed: SignedQuote, kind: CoverBlock['kind'], receipt: BuyReceipt | null): CoverBlock {
  const { quote } = signed
  return {
    key: quote.key,
    start: Number(quote.start),
    end: Number(quote.end),
    premium: quote.premium,
    ratePerSecond: quote.ratePerSecond,
    kind,
    policyId: receipt?.policyId ?? null,
    transactionHash: receipt?.transactionHash ?? null,
  }
}
