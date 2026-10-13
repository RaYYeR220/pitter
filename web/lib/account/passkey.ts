import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  type PasskeyCredentialMetadata,
  type WebAuthnClient,
} from '@category-labs/mera'

/** Enough to point a later prompt at one passkey. Not a secret, and never needed to sign in. */
export interface CredentialHint {
  credentialId: string
  transports?: readonly string[]
}

export interface PasskeyResult {
  credential: CredentialHint
  /** 32 bytes of key material. The caller zeroes them when done. */
  prfOutput: Uint8Array<ArrayBuffer>
}

/**
 * The passkey ceremonies the app runs. Each call shows one prompt and returns the PRF output for one salt;
 * a different salt is a different, unrelated key from the same passkey.
 */
export interface Passkeys {
  /** Creates a passkey and evaluates `prfSalt` (the account salt when omitted). */
  create(options: { label: string; prfSalt?: Uint8Array }): Promise<PasskeyResult>
  /** Evaluates `prfSalt` with an existing passkey: the hinted one, or any passkey of this site. */
  evaluate(options?: { credential?: CredentialHint; prfSalt?: Uint8Array }): Promise<PasskeyResult>
}

export interface RelyingParty {
  /** The host the passkeys belong to. Changing it orphans every account. */
  id: string
  name: string
}

declare global {
  var __pitterWebAuthnClient: WebAuthnClient | undefined
}

/**
 * Development and test builds can replace the WebAuthn client, because an automated browser has no
 * authenticator that two browser profiles can share. The check is on a build-time constant, so production
 * bundles contain neither the switch nor a way to reach it.
 */
function replacementClient(): WebAuthnClient | undefined {
  if (process.env.NODE_ENV === 'production') return undefined
  return globalThis.__pitterWebAuthnClient
}

/** Passkey ceremonies through Mera. This is the only place the app touches WebAuthn. */
export function meraPasskeys(relyingParty: () => RelyingParty): Passkeys {
  const withClient = <T extends object>(options: T): T & { webAuthnClient?: WebAuthnClient } => {
    const webAuthnClient = replacementClient()
    return webAuthnClient ? { ...options, webAuthnClient } : options
  }

  return {
    async create({ label, prfSalt }) {
      const created = await createPasskeyWithPrfOutput(
        withClient({
          rp: relyingParty(),
          user: { name: label, displayName: label },
          ...(prfSalt ? { prfSalt } : {}),
        }),
      )
      return {
        credential: {
          credentialId: created.credentialId,
          ...(created.transports ? { transports: [...created.transports] } : {}),
        },
        prfOutput: created.prfOutput,
      }
    },

    async evaluate({ credential, prfSalt } = {}) {
      const result = await getPasskeyPrfOutput(
        withClient({
          rpId: relyingParty().id,
          ...(credential ? { credential: credential as PasskeyCredentialMetadata } : {}),
          ...(prfSalt ? { prfSalt } : {}),
        }),
      )
      return {
        credential: {
          credentialId: result.credentialId,
          ...(credential?.credentialId === result.credentialId && credential.transports
            ? { transports: credential.transports }
            : {}),
        },
        prfOutput: result.prfOutput,
      }
    },
  }
}

/** The relying party of the page the app is open on. */
export function pageRelyingParty(name: string): RelyingParty {
  return { id: globalThis.location.hostname, name }
}
