export interface ServiceErrorOptions {
  details?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/**
 * An error that is safe to show to a client. Anything else that escapes a handler is reported as a bare 500.
 */
export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(status: number, code: string, message: string, options: ServiceErrorOptions = {}) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.headers = options.headers;
  }
}

export const badRequest = (code: string, message: string, details?: Record<string, unknown>) =>
  new ServiceError(400, code, message, details ? { details } : {});

export const unauthorized = (message = "Missing or invalid credentials") =>
  new ServiceError(401, "unauthorized", message);

export const forbidden = (code: string, message: string) => new ServiceError(403, code, message);

export const notFound = (message = "Not found") => new ServiceError(404, "not_found", message);

export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new ServiceError(409, code, message, details ? { details } : {});

export const unprocessable = (code: string, message: string, details?: Record<string, unknown>) =>
  new ServiceError(422, code, message, details ? { details } : {});

export const tooManyRequests = (retryAfterSeconds: number) =>
  new ServiceError(429, "rate_limited", "Too many requests", {
    details: { retryAfterSeconds },
    headers: { "retry-after": String(retryAfterSeconds) },
  });

export const unavailable = (code: string, message: string, details?: Record<string, unknown>) =>
  new ServiceError(503, code, message, details ? { details } : {});
