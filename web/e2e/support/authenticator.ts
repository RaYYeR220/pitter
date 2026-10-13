import type { BrowserContext, CDPSession, Page } from '@playwright/test'

export interface VirtualAuthenticator {
  cdp: CDPSession
  id: string
  /** The passkeys it holds, in the form `WebAuthn.addCredential` takes back. */
  credentials(): Promise<VirtualCredential[]>
  add(credential: VirtualCredential): Promise<void>
}

export interface VirtualCredential {
  credentialId: string
  isResidentCredential: boolean
  rpId?: string
  privateKey: string
  userHandle?: string
  signCount: number
  [field: string]: unknown
}

/**
 * Attaches Chromium's virtual authenticator to a page: a platform authenticator with resident keys, user
 * verification that always succeeds, and the PRF extension.
 */
export async function attachAuthenticator(context: BrowserContext, page: Page): Promise<VirtualAuthenticator> {
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  })
  return {
    cdp,
    id: authenticatorId,
    async credentials() {
      const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId })
      return credentials as VirtualCredential[]
    },
    async add(credential) {
      await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: credential as never })
    },
  }
}

/** Asks the page's authenticator directly for a PRF output, bypassing the app. Null when it returns none. */
export function rawPrf(page: Page, credentialId: string): Promise<string | null> {
  return page.evaluate(async (id) => {
    const decode = (text: string) =>
      Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')), (c) =>
        c.charCodeAt(0),
      )
    const credential = (await navigator.credentials.get({
      publicKey: {
        rpId: location.hostname,
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        userVerification: 'required',
        allowCredentials: [{ id: decode(id), type: 'public-key' }],
        extensions: { prf: { eval: { first: new Uint8Array(32).fill(7) } } },
      },
    })) as PublicKeyCredential
    const first = (credential.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf?.results
      ?.first
    return first ? [...new Uint8Array(first)].map((byte) => byte.toString(16).padStart(2, '0')).join('') : null
  }, credentialId)
}

/**
 * A WebAuthn client for tests only, installed before the app loads. It runs the real ceremony on the
 * virtual authenticator and computes the PRF output itself, as HMAC-SHA-256 under a key derived from a test
 * seed and the credential id, because Chromium cannot carry a passkey's PRF secret into a second
 * authenticator. The app picks it up only in development builds.
 */
export function testPrfClientScript(seed: string): string {
  return `(() => {
  const seed = new TextEncoder().encode(${JSON.stringify(seed)});
  const hmac = async (keyBytes, data) => {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
  };
  const prf = async (credentialId, salt) => {
    const secret = await hmac(seed, credentialId);
    return hmac(secret, salt);
  };
  globalThis.__pitterWebAuthnClient = {
    async createCredential(request) {
      const credential = await navigator.credentials.create({ publicKey: {
        rp: request.rp, user: request.user, challenge: request.challenge,
        pubKeyCredParams: request.algorithms.map((alg) => ({ type: 'public-key', alg })),
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        attestation: 'none',
        extensions: { prf: { eval: { first: request.prfSalt } } },
      } });
      const id = new Uint8Array(credential.rawId);
      return { credentialId: id, transports: credential.response.getTransports(), prfEnabled: true, prfOutput: await prf(id, request.prfSalt) };
    },
    async getCredential(request) {
      const allow = request.allowCredential ? { allowCredentials: [{ id: request.allowCredential.credentialId, type: 'public-key' }] } : {};
      const credential = await navigator.credentials.get({ publicKey: {
        rpId: request.rpId, challenge: request.challenge, userVerification: 'required', ...allow,
      } });
      const id = new Uint8Array(credential.rawId);
      return { credentialId: id, prfOutput: await prf(id, request.prfSalt) };
    },
  };
})();`
}
