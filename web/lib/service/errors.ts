/**
 * A request to the service that did not succeed. `status` is the HTTP status, or 0 when no answer arrived at
 * all; `code` is the service's own error code, or one of the client-side codes below.
 */
export class ServiceFailure extends Error {
  readonly status: number
  readonly code: string
  readonly details: Readonly<Record<string, unknown>>

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ServiceFailure'
    this.status = status
    this.code = code
    this.details = details
  }
}

/** The request never reached the service, or its answer never came back. */
export const NETWORK = 'network'
/** The service did not answer in time. */
export const TIMEOUT = 'timeout'
/** The service answered with something this client does not understand. */
export const BAD_RESPONSE = 'bad_response'

export function isServiceFailure(error: unknown): error is ServiceFailure {
  return error instanceof ServiceFailure
}

/**
 * Whether the service may have sent a transaction for a request that failed this way. The service refuses
 * before sending with a 4xx or a 503; anything else, and no answer at all, leaves the outcome open until the
 * chain has been asked.
 */
export function outcomeUnknown(failure: ServiceFailure): boolean {
  if (failure.status === 0) return true
  if (failure.code === 'in_progress') return true
  return failure.status >= 500 && failure.status !== 503
}
