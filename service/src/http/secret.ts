import { unauthorized, unavailable } from './errors'

const encoder = new TextEncoder()

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}

/** Compares two secrets without revealing, through timing, how much of a guess was right. */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([digest(a), digest(b)])
  let difference = 0
  for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!
  return difference === 0
}

/**
 * Requires the shared secret in `header`, or as a bearer token. With no secret configured the endpoint is
 * closed, never open.
 */
export async function requireSecret(request: Request, header: string, expected: string | undefined): Promise<void> {
  if (!expected) throw unavailable('not_configured', 'This endpoint is not enabled')
  const bearer = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1]
  const presented = request.headers.get(header) ?? bearer
  if (!presented || !(await secretsEqual(presented, expected))) throw unauthorized()
}
