import { ServiceError, badRequest } from "./errors";

const tooLarge = (maxBytes: number) =>
  new ServiceError(413, "body_too_large", `The request body is larger than ${maxBytes} bytes`);

/** Reads the request body, refusing anything above `maxBytes` without buffering it first. */
export async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0) throw badRequest("invalid_request", "Invalid content-length");
    if (length > maxBytes) throw tooLarge(maxBytes);
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export const MAX_JSON_BYTES = 16 * 1024;

export async function readJson(request: Request, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
  const bytes = await readBytes(request, maxBytes);
  if (bytes.byteLength === 0) throw badRequest("invalid_json", "The request body must be JSON");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw badRequest("invalid_json", "The request body must be JSON");
  }
}
