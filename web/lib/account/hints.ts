import { getAddress, isAddress, type Address } from 'viem'
import type { CredentialHint } from './passkey'

/**
 * A convenience kept on the device: which passkey signed in last, and to which account. It only lets the next
 * prompt go straight to that passkey. It is not a secret, the account does not depend on it, and signing in
 * works the same with storage wiped.
 */
export interface AccountHint {
  credential: CredentialHint
  address: Address
}

export interface HintStore {
  load(): AccountHint | null
  save(hint: AccountHint): void
  clear(): void
}

export const HINT_KEY = 'pitter.account-hint.v1'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function parse(text: string | null): AccountHint | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as { credential?: { credentialId?: unknown; transports?: unknown }; address?: unknown }
    const credentialId = value.credential?.credentialId
    if (typeof credentialId !== 'string' || !/^[A-Za-z0-9_-]{8,1024}$/.test(credentialId)) return null
    if (typeof value.address !== 'string' || !isAddress(value.address, { strict: false })) return null
    const transports = value.credential?.transports
    return {
      credential: {
        credentialId,
        ...(Array.isArray(transports) && transports.every((entry) => typeof entry === 'string')
          ? { transports: transports as string[] }
          : {}),
      },
      address: getAddress(value.address),
    }
  } catch {
    return null
  }
}

/** Hints in the browser's local storage. Storage that is missing, full or blocked is treated as empty. */
export function browserHintStore(storage: () => StorageLike | undefined = () => globalThis.localStorage): HintStore {
  const open = (): StorageLike | undefined => {
    try {
      return storage()
    } catch {
      return undefined
    }
  }
  return {
    load() {
      try {
        return parse(open()?.getItem(HINT_KEY) ?? null)
      } catch {
        return null
      }
    },
    save(hint) {
      try {
        open()?.setItem(HINT_KEY, JSON.stringify(hint))
      } catch {
        // A device that refuses storage loses only the shortcut.
      }
    },
    clear() {
      try {
        open()?.removeItem(HINT_KEY)
      } catch {
        // Nothing to clear.
      }
    },
  }
}

export const noHints: HintStore = { load: () => null, save() {}, clear() {} }
