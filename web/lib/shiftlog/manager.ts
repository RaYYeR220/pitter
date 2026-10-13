import type { Address } from 'viem'
import {
  currentPlatform,
  describeAccountError,
  type AccountProblem,
  type CredentialHint,
  type Passkeys,
  type Platform,
} from '../account'
import { isServiceFailure } from '../service/errors'
import { ShiftLogCryptoError, deriveShiftLogKeys, shiftLogSalt, type ShiftLogKeys } from './crypto'
import {
  ShiftLogFormatError,
  addPoint,
  addShift,
  editShift,
  mergeLogs,
  newShift,
  removeShift,
  type ShiftLog,
  type TrailPoint,
} from './model'
import type { ShiftLogStore } from './store'

export type ShiftLogStatus = 'locked' | 'unlocking' | 'unlocked'

/** `saved`: storage has this copy. `unsaved`: edited since. `failed`: storage refused; the copy in memory is intact. */
export type ShiftLogSync = 'saved' | 'unsaved' | 'saving' | 'failed'

export type ShiftLogError = 'load_failed' | 'cannot_open'

export interface ShiftLogState {
  status: ShiftLogStatus
  /** The decrypted log. Null while locked: nothing of it stays in memory. */
  log: ShiftLog | null
  /** Where the ciphertext is stored. Unrelated to the account's address. */
  storageAddress: Address | null
  sync: ShiftLogSync
  /** When storage last accepted a copy, unix seconds. */
  savedAt: number | null
  /** Why unlocking did not produce a log. */
  error: ShiftLogError | null
  /** What went wrong with the passkey prompt. */
  problem: AccountProblem | null
}

export interface ShiftLogManagerOptions {
  passkeys: Passkeys
  store: ShiftLogStore
  /** The passkey to prompt for, when an account is signed in. */
  credential?: () => CredentialHint | undefined
  /** Unix seconds. */
  now?: () => number
  newId?: () => string
  platform?: () => Platform
}

const LOCKED: ShiftLogState = {
  status: 'locked',
  log: null,
  storageAddress: null,
  sync: 'saved',
  savedAt: null,
  error: null,
  problem: null,
}

/**
 * The private shift log: exact positions, shift names and notes, readable only with the passkey.
 *
 * Unlocking is its own passkey prompt, on the shift log's own salt. Its result is turned into an encryption
 * key and a storage identity that exist only in this object; locking drops both and the decrypted log with
 * them. Storage holds ciphertext, so losing or leaking it reveals nothing, and a device that has never seen
 * the log rebuilds the same keys from the passkey and reads the same data.
 */
export class ShiftLogManager {
  private readonly passkeys: Passkeys
  private readonly store: ShiftLogStore
  private readonly credential: () => CredentialHint | undefined
  private readonly now: () => number
  private readonly newId: () => string
  private readonly platform: () => Platform
  private readonly listeners = new Set<() => void>()
  private keys: ShiftLogKeys | null = null
  private storedAt: number | null = null
  private state: ShiftLogState = LOCKED
  private saving: Promise<boolean> | null = null

  constructor(options: ShiftLogManagerOptions) {
    this.passkeys = options.passkeys
    this.store = options.store
    this.credential = options.credential ?? (() => undefined)
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.platform = options.platform ?? currentPlatform
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): ShiftLogState => this.state

  /** One passkey prompt, then the stored log is fetched and decrypted. */
  async unlock(): Promise<boolean> {
    if (this.state.status !== 'locked') return this.state.status === 'unlocked'
    this.set({ ...LOCKED, status: 'unlocking' })

    let keys: ShiftLogKeys
    try {
      const credential = this.credential()
      const { prfOutput } = await this.passkeys.evaluate({
        ...(credential ? { credential } : {}),
        prfSalt: shiftLogSalt(),
      })
      try {
        keys = await deriveShiftLogKeys(prfOutput)
      } finally {
        prfOutput.fill(0)
      }
    } catch (error) {
      this.set({ ...LOCKED, problem: describeAccountError(error, this.platform()) })
      return false
    }

    try {
      const { log, storedAt } = await this.store.load(keys)
      this.keys = keys
      this.storedAt = storedAt
      this.set({
        ...LOCKED,
        status: 'unlocked',
        log,
        storageAddress: keys.storage.address,
        savedAt: storedAt,
      })
      return true
    } catch (error) {
      keys.storage.end()
      const cannotOpen = error instanceof ShiftLogCryptoError || error instanceof ShiftLogFormatError
      this.set({ ...LOCKED, error: cannotOpen ? 'cannot_open' : 'load_failed' })
      return false
    }
  }

  /** Forgets the keys and the decrypted log. Unsaved edits are lost; save first. */
  lock(): void {
    this.keys?.storage.end()
    this.keys = null
    this.storedAt = null
    this.set(LOCKED)
  }

  /** Starts a new entry and returns its id, or null while locked. */
  startShift(label = ''): string | null {
    const id = this.newId()
    return this.edit((log) => addShift(log, newShift(id, this.now(), label))) ? id : null
  }

  editShift(id: string, changes: { label?: string; note?: string }): void {
    this.edit((log) => editShift(log, id, changes, this.now()))
  }

  endShift(id: string): void {
    this.edit((log) => editShift(log, id, { endedAt: this.now() }, this.now()))
  }

  removeShift(id: string): void {
    this.edit((log) => removeShift(log, id))
  }

  /** Adds an exact position to a shift's route. */
  addPoint(id: string, point: Omit<TrailPoint, 'at'> & { at?: number }): void {
    this.edit((log) => addPoint(log, id, { ...point, at: point.at ?? this.now() }))
  }

  /**
   * Encrypts the log and stores it. When storage holds a newer copy, written by another device, the two are
   * merged and stored again. When storage cannot be reached the log stays in memory, marked as not saved.
   */
  save(): Promise<boolean> {
    this.saving ??= this.persist().finally(() => {
      this.saving = null
    })
    return this.saving
  }

  private async persist(): Promise<boolean> {
    const keys = this.keys
    if (!keys || !this.state.log) return false
    this.update({ sync: 'saving' })

    for (let attempt = 0; attempt < 2; attempt++) {
      const submitted = this.state.log
      if (!submitted) return false
      try {
        const { log, storedAt } = await this.store.save(keys, submitted, this.storedAt)
        if (this.keys !== keys) return false
        this.storedAt = storedAt
        const edited = this.state.log !== submitted
        this.update({
          log: edited ? this.state.log : log,
          sync: edited ? 'unsaved' : 'saved',
          savedAt: storedAt,
        })
        return true
      } catch (error) {
        if (this.keys !== keys) return false
        if (attempt === 0 && isServiceFailure(error) && error.code === 'stale_write') {
          try {
            const stored = await this.store.load(keys)
            this.storedAt = stored.storedAt
            if (this.state.log) this.update({ log: mergeLogs(this.state.log, stored.log) })
            continue
          } catch {
            break
          }
        }
        break
      }
    }
    if (this.keys === keys) this.update({ sync: 'failed' })
    return false
  }

  private edit(change: (log: ShiftLog) => ShiftLog): boolean {
    if (this.state.status !== 'unlocked' || !this.state.log) return false
    this.update({ log: change(this.state.log), sync: 'unsaved' })
    return true
  }

  private update(patch: Partial<ShiftLogState>): void {
    this.set({ ...this.state, ...patch })
  }

  private set(state: ShiftLogState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}
