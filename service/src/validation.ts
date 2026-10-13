import { getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { z } from "zod";

const SECP256K1_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

const DECIMAL = /^(0|[1-9]\d{0,77})$/;

/** Unsigned integer of at most `bits` bits, given as a decimal string or a safe JSON number. */
export const uint = (bits: number) =>
  z
    .union([z.string().regex(DECIMAL, "Expected a decimal integer"), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
    .transform((value) => BigInt(value))
    .refine((value) => value < 1n << BigInt(bits), `Expected an unsigned ${bits}-bit integer`);

/** A 20-byte address. Mixed-case input must carry a valid checksum; the output is checksummed. */
export const address = z
  .string()
  .refine((value) => isAddress(value, { strict: true }), "Expected an address")
  .transform((value) => getAddress(value) as Address);

export const holderAddress = address.refine((value) => value !== zeroAddress, "The zero address is not allowed");

export const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "Expected 32 bytes of hex")
  .transform((value) => value.toLowerCase() as Hex);

/** A 65-byte ECDSA signature. */
export const signature = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130}$/, "Expected a 65-byte signature")
  .transform((value) => value.toLowerCase() as Hex);

export const recoveryId = z.union([z.literal(27), z.literal(28)], "Expected v to be 27 or 28");

/** The `s` half of a signature in the lower half of the curve order, as the token and the contracts require. */
export const lowS = bytes32.refine((value) => BigInt(value) <= SECP256K1_HALF_ORDER && BigInt(value) !== 0n, "Expected a low-s signature");

export const quoteSchema = z.strictObject({
  holder: holderAddress,
  key: uint(256),
  start: uint(64),
  end: uint(64),
  ratePerSecond: uint(128),
  premium: uint(128),
  expiry: uint(64),
  salt: bytes32,
});

const authorizationFields = {
  validAfter: uint(256),
  validBefore: uint(256),
  v: recoveryId,
  r: bytes32,
  s: lowS,
};

export const relayBuySchema = z.strictObject({
  quote: quoteSchema,
  quoteSig: signature,
  ...authorizationFields,
});

export const relayDepositSchema = z.strictObject({
  assets: uint(256).refine((value) => value > 0n, "Expected a positive amount"),
  receiver: holderAddress,
  nonce: bytes32,
  ...authorizationFields,
});

export const relayTransferSchema = z.strictObject({
  from: holderAddress,
  to: holderAddress,
  value: uint(256).refine((value) => value > 0n, "Expected a positive amount"),
  nonce: bytes32,
  ...authorizationFields,
});

export const MAX_SETTLE_IDS = 10;

export const relaySettleSchema = z.strictObject({
  ids: z
    .array(uint(64).refine((value) => value > 0n, "Policy ids start at 1"))
    .min(1)
    .max(MAX_SETTLE_IDS)
    .refine((ids) => new Set(ids).size === ids.length, "Policy ids must be distinct"),
});

const coordinate = (limit: number) =>
  z
    .union([z.number(), z.string().regex(/^-?\d{1,3}(\.\d{1,8})?$/, "Expected a decimal coordinate")])
    .transform((value) => Number(value))
    .refine((value) => Number.isFinite(value) && Math.abs(value) <= limit, `Expected a value between -${limit} and ${limit}`);

/** What a caller asks cover for: where, when, and how much per wet second. */
export const coverRequestSchema = z.strictObject({
  lat: coordinate(90),
  lon: coordinate(180),
  start: uint(64),
  end: uint(64),
  rate: uint(128).refine((value) => value > 0n, "Expected a positive rate"),
  holder: holderAddress,
});

export type CoverRequest = z.infer<typeof coverRequestSchema>;

export const dripSchema = z.strictObject({ address: holderAddress });

export const stormSchema = z.strictObject({ wet: z.boolean() });

export const blobName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "Expected a short lowercase name");
