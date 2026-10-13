import type { Address, Hex } from "viem";

/** Terms of one cover purchase, as signed by the underwriter. Mirrors the `Quote` struct of the cover book. */
export interface Quote {
  holder: Address;
  key: bigint;
  start: bigint;
  end: bigint;
  ratePerSecond: bigint;
  premium: bigint;
  expiry: bigint;
  salt: Hex;
}

/** One oracle observation. Mirrors the `Reading` struct of the weather index. */
export interface Reading {
  key: bigint;
  from: bigint;
  to: bigint;
  wetSeconds: number;
}

/** Split ECDSA signature in the form the ERC-3009 entry points take. */
export interface SplitSignature {
  v: number;
  r: Hex;
  s: Hex;
}

/** Validity window and signature of an ERC-3009 authorization. */
export interface Authorization extends SplitSignature {
  validAfter: bigint;
  validBefore: bigint;
}

export type Clock = () => number;

export const MINUTE = 60;
