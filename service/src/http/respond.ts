import { ZodError } from "zod";
import { ServiceError } from "./errors";

export type Handler = (request: Request) => Promise<Response>;

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

const BASE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

function stringify(body: unknown): string {
  return JSON.stringify(body, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
}

/** JSON response. Big integers are written as decimal strings. */
export function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(stringify(body), {
    status: init.status ?? 200,
    headers: { ...BASE_HEADERS, ...init.headers },
  });
}

export function errorResponse(error: ServiceError): Response {
  const body: Record<string, unknown> = { code: error.code, message: error.message };
  if (error.details) body.details = error.details;
  return json({ error: body }, { status: error.status, ...(error.headers ? { headers: error.headers } : {}) });
}

function validationError(error: ZodError): ServiceError {
  const issues = error.issues.slice(0, 10).map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
  return new ServiceError(400, "invalid_request", "The request is not valid", { details: { issues } });
}

/**
 * Wraps a handler so that nothing but a `ServiceError` ever reaches the client. Unexpected failures are logged
 * under a reference and answered with a 500 that carries only that reference.
 */
export function guard(name: string, handler: Handler, logger: Logger): Handler {
  return async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      if (error instanceof ServiceError) return errorResponse(error);
      if (error instanceof ZodError) return errorResponse(validationError(error));
      const reference = crypto.randomUUID();
      logger.error("unhandled error", { handler: name, reference, error });
      return errorResponse(new ServiceError(500, "internal", "Internal error", { details: { reference } }));
    }
  };
}
